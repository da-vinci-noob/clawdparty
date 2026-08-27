import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLoop } from "../../src/loop/run_loop.js";
import { AnthropicBedrockAdapter } from "../../src/providers/anthropic_bedrock.js";
import { AnthropicDirectAdapter } from "../../src/providers/anthropic_direct.js";
import { BedrockConverseAdapter } from "../../src/providers/bedrock_converse.js";
import type {
  Capabilities,
  EntitlementPosture,
  FailureHints,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";
import { buildAdapters } from "../../src/providers/index.js";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * A credential that expires DURING a session, which nothing exercised.
 *
 * Every existing credential test starts from one that was already broken, so the whole *during*
 * case was uncovered: a 401 arriving on turn 3 of a live run, and an SSO session expiring in the
 * window between `probe()` and `stream()` — a window Bedrock's presence-only probe makes wide by
 * design.
 *
 * asks for two things and the second is easy to lose: the message must name the specific
 * credential AND THE FIX, and the session must stay USABLE. A run that dies is fine; a session that
 * cannot be used afterwards is not.
 */

const CAPS: Capabilities = {
  streaming: true,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** An HTTP-shaped error, the way a vendor SDK raises one. */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** A turn that ENDS, for a run that should complete. */
const TEXT_TURN: ProviderEvent[] = [
  { t: "message_start", model: "m" },
  { t: "block_start", index: 0, kind: "text" },
  { t: "block_stop", index: 0, block: { type: "text", text: "done" } },
  { t: "message_delta", stopReason: "end_turn", usage },
  { t: "message_stop" },
];

/** A tool-use turn, so the loop keeps going and reaches a later turn. */
const TOOL_TURN: ProviderEvent[] = [
  { t: "message_start", model: "m" },
  { t: "block_start", index: 0, kind: "tool_use" },
  {
    t: "block_stop",
    index: 0,
    block: { type: "tool_use", id: "tu", name: "read", input: { path: "x.txt" } },
  },
  { t: "message_delta", stopReason: "tool_use", usage },
  { t: "message_stop" },
];

/**
 * Succeeds for `healthyTurns`, then throws on every turn after — a credential that worked and
 * stopped working, which is the whole subject.
 */
class ExpiringAdapter implements ProviderAdapter {
  readonly displayName = "Expiring";
  readonly entitlement: EntitlementPosture = {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test double",
  };
  turns = 0;

  constructor(
    readonly id: string,
    private readonly healthyTurns: number,
    private readonly failure: Error,
    /** Turn number at which to end the run cleanly; omitted means "keep asking for tools". */
    private readonly endsAt?: number,
  ) {}

  async probe(): Promise<ProbeResult> {
    // Reports HEALTHY throughout: the point is that a probe cannot see the future, which is why
    // the expiry has to be handled at stream time.
    return { available: true, credentialSource: "env:ANTHROPIC_API_KEY" };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m", displayName: "M", capabilities: CAPS }];
  }
  capabilities(): Capabilities {
    return CAPS;
  }

  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.turns += 1;
    if (this.turns > this.healthyTurns) throw this.failure;
    // A tool turn keeps the loop going so a LATER turn can fail; `endsAt` is how a run that is
    // supposed to succeed actually terminates instead of looping to MAX_TURNS.
    const ending = this.endsAt !== undefined && this.turns >= this.endsAt;
    for (const event of ending ? TEXT_TURN : TOOL_TURN) yield event;
  }
}

let base: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "harness-reauth-"));
  mkdirSync(join(base, "worktree"), { recursive: true });
  const opened = await openStore("45", { dir: join(base, "store"), owner: "reauth" });
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  store = opened.store;
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function run(adapter: ProviderAdapter, runId = "1"): Promise<EventEnvelope[]> {
  const emitted: EventEnvelope[] = [];
  const loop = new RunLoop({
    store,
    adapter,
    tools: new ToolRegistry(),
    emit: (batch) => emitted.push(...batch),
    now: () => 1_700_000_000_000,
    newId: () => `turn-${runId}`,
  });
  await loop.run({
    runId,
    sessionId: "45",
    lane: "main",
    prompt: "P",
    requestedBy: "7",
    model: "m",
    cwd: join(base, "worktree"),
    systemPrompt: "S",
    signal: new AbortController().signal,
  });
  return emitted;
}

const providerError = (events: EventEnvelope[]) =>
  events.find((e) => e.type === "provider_error")?.payload as
    | { kind?: string; message?: string; remedy?: string; provider?: string }
    | undefined;

describe("a 401 arriving mid-run", () => {
  it("is classified as an expired credential, not a generic api error", async () => {
    const events = await run(new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope")));

    expect(providerError(events)?.kind).toBe("credential_expired");
  });

  it("names a fix, so the participant knows what to do", async () => {
    const events = await run(new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope")));

    // 's second half. "The provider rejected the credential" alone leaves a room stuck.
    expect(providerError(events)?.remedy ?? "").not.toBe("");
  });

  it("fails the run rather than hanging or looping", async () => {
    const events = await run(new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope")));

    // A retry loop against an expired credential burns turns and says nothing.
    expect(events.find((e) => e.type === "run_failed")).toBeDefined();
  });

  it("keeps the work the healthy turns already did", async () => {
    const adapter = new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope"));
    await run(adapter);

    // Two turns ran before the credential died; their entries are history and must survive the
    // failure. Discarding them would lose work the participant watched happen.
    expect(adapter.turns).toBe(3);
    expect(store.entriesFrom(0).length).toBeGreaterThan(2);
  });

  it("LEAVES THE SESSION USABLE — a later run starts and completes", async () => {
    await run(new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope")), "1");

    // The credential was refreshed; the session must accept a new run. This is the half of
    // that is easy to lose: a run may die, a session may not.
    const healthy = new ExpiringAdapter("anthropic-direct", 99, httpError(401, "unused"), 1);
    const events = await run(healthy, "2");

    expect(events.find((e) => e.type === "run_failed")).toBeUndefined();
    expect(events.find((e) => e.type === "run_finished")).toBeDefined();
  });

  it("records the failure so a restart can still explain it", async () => {
    await run(new ExpiringAdapter("anthropic-direct", 2, httpError(401, "nope")));

    // `provider_error` that is only broadcast vanishes on restart, and `run_failed` carries a stop
    // reason with no explanation — the reason this is persisted at all.
    const stored = JSON.stringify(store.entriesFrom(0));
    expect(stored).toContain("credential_expired");
  });
});

/**
 * Two separate claims, deliberately split. An earlier version of this file conflated them and
 * failed for the wrong reason: it asserted the REAL adapters' wording through a test double that
 * had no hints at all, so it was measuring the fallback.
 */
describe("the loop uses the ADAPTER's words, not its own", () => {
  const withHints = (id: string, hints: FailureHints) =>
    Object.assign(new ExpiringAdapter(id, 1, httpError(401, "nope")), { failureHints: hints });

  it("carries the adapter's expired-credential remedy through to the event", async () => {
    const events = await run(
      withHints("some-provider", {
        expired: "Run `the-right-command` and start a new run.",
        notEntitled: "not-this-one",
        unreachable: "nor-this-one",
      }),
    );

    expect(providerError(events)?.remedy).toBe("Run `the-right-command` and start a new run.");
  });

  it("carries the adapter's not-entitled remedy for a 403", async () => {
    const adapter = Object.assign(new ExpiringAdapter("p", 1, httpError(403, "denied")), {
      failureHints: { expired: "no", notEntitled: "Ask for model access.", unreachable: "no" },
    });

    expect(providerError(await run(adapter))?.remedy).toBe("Ask for model access.");
  });

  it("falls back to VAGUE advice, never to another provider's command", async () => {
    // The design point: an adapter that declares no hints should say something non-specific. Advice
    // for the wrong credential is worse than advice with no command in it.
    const remedy = providerError(
      await run(new ExpiringAdapter("p", 1, httpError(401, "x"))),
    )?.remedy;

    expect(remedy).not.toBe("");
    expect(remedy).not.toMatch(/setup-token|aws sso login/i);
  });

  it("names the provider on the event, so the room knows WHICH credential", async () => {
    const events = await run(new ExpiringAdapter("anthropic-bedrock", 1, httpError(401, "nope")));

    expect(providerError(events)?.provider).toBe("anthropic-bedrock");
  });
});

describe("each REAL adapter's words are right for its own credential", () => {
  it("tells a Bedrock session to run `aws sso login`, not `claude setup-token`", () => {
    // The defect this pins: one hardcoded remedy for every provider sent a developer whose AWS SSO
    // session had expired to run `claude setup-token` — which fixes nothing and is confidently
    // wrong. Exactly this was fixed for the DISCOVERY path; this is the stream path.
    const hints = new AnthropicBedrockAdapter({ env: {} }).failureHints;

    expect(hints?.expired).toMatch(/aws sso login/i);
    expect(hints?.expired).not.toMatch(/setup-token/i);
  });

  it("tells a Converse session the same, since it is the same AWS session", () => {
    expect(new BedrockConverseAdapter({ env: {} }).failureHints?.expired).toMatch(/aws sso login/i);
  });

  it("tells an Anthropic-direct session to refresh its key or token", () => {
    expect(new AnthropicDirectAdapter().failureHints?.expired).toMatch(/setup-token|key/i);
  });

  it("does not offer re-authentication as the fix for a 403 on any adapter", () => {
    // Re-authenticating a valid-but-unentitled credential sends someone in a circle.
    for (const adapter of [
      new AnthropicBedrockAdapter({ env: {} }),
      new BedrockConverseAdapter({ env: {} }),
      new AnthropicDirectAdapter(),
    ]) {
      expect(adapter.failureHints?.notEntitled, adapter.id).not.toMatch(/sso login|setup-token/i);
    }
  });

  it("gives every registered adapter its own hints, so none falls back in production", () => {
    // The fallback exists for test doubles. A real adapter reaching it would emit vague advice to a
    // participant who could have been told the exact command.
    for (const adapter of buildAdapters()) {
      expect(adapter.failureHints, adapter.id).toBeDefined();
    }
  });
});

describe("other mid-run provider failures", () => {
  it("distinguishes a 403 (not entitled) from an expired credential", async () => {
    const events = await run(new ExpiringAdapter("anthropic-bedrock", 1, httpError(403, "denied")));

    // Re-authenticating fixes nothing here, so telling someone to log in again is wrong advice.
    expect(providerError(events)?.kind).toBe("not_entitled");
    expect(providerError(events)?.remedy).not.toMatch(/sso login|setup-token/i);
  });

  it("keeps 429 as a retryable api error, not a credential problem", async () => {
    const events = await run(new ExpiringAdapter("anthropic-direct", 1, httpError(429, "slow")));

    expect(providerError(events)?.kind).toBe("api_error");
    expect(providerError(events)?.remedy).toMatch(/wait|retry/i);
  });

  it("still names a remedy for an unclassifiable failure", async () => {
    const events = await run(
      new ExpiringAdapter("anthropic-direct", 1, new Error("socket hang up")),
    );

    // Never a bare message:  admits no generic failure.
    expect(providerError(events)?.remedy ?? "").not.toBe("");
    expect(providerError(events)?.kind).toBe("api_error");
  });
});

describe("expiry in the window between probe and stream", () => {
  it("is reported from the STREAM, since the probe reported healthy", async () => {
    // Bedrock's probe is presence-only by design, so this window is wide and real: a
    // credential can pass discovery and be dead by the time the request goes out.
    const adapter = new ExpiringAdapter("anthropic-bedrock", 0, httpError(401, "expired"));
    expect((await adapter.probe()).available).toBe(true);

    const events = await run(adapter);

    expect(providerError(events)?.kind).toBe("credential_expired");
    expect(events.find((e) => e.type === "run_failed")).toBeDefined();
  });
});
