import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@clawdparty/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLoop } from "../../src/loop/run_loop.js";
import type {
  Capabilities,
  EntitlementPosture,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
} from "../../src/providers/contract.js";
import { Supervisor } from "../../src/supervisor.js";
import { Transport } from "../../src/transport.js";

/**
 * interrupting one lane leaves the other running.
 *
 * Driven through the real `Supervisor`, because that is where the claim lives: each run owns its own
 * `AbortController`, and `interrupt` resolves one by run id. What could break it is shared state —
 * two lanes share one store (refcounted per session, deliberately), so a release or an abort that
 * reached the store rather than the run would take both lanes down together.
 *
 * The adapter below hangs until aborted, so "still running" is observable rather than a race.
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
  liveModelDiscovery: false,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

/** Hangs until the run's signal aborts — so a lane stays live for as long as the test needs. */
const hangingAdapter: ProviderAdapter = {
  id: "anthropic-direct",
  displayName: "hanging",
  entitlement: {
    credentialKind: "api_key",
    thirdPartyClientPermitted: "yes",
    note: "test double",
  } satisfies EntitlementPosture,
  probe: async (): Promise<ProbeResult> => ({
    available: true,
    credentialSource: "env:ANTHROPIC_API_KEY",
  }),
  listModels: async (): Promise<ModelInfo[]> => [],
  capabilities: () => CAPS,
  stream: (req: ProviderRequest): AsyncIterable<ProviderEvent> =>
    (async function* () {
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) return resolve();
        req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })(),
};

let dir: string;
let supervisor: Supervisor;

function silentTransport(): Transport {
  return new Transport({
    railsInternalUrl: "http://rails:3000",
    sharedSecret: "s",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-lane-interrupt-"));
  supervisor = new Supervisor(silentTransport(), {
    storeDir: dir,
    adapters: { "anthropic-direct": hangingAdapter },
    buildLoop: ({ store, adapter, emit }) =>
      new RunLoop({
        store,
        adapter,
        // A registry stand-in: this test never dispatches a tool.
        tools: new (class {
          get() {
            return undefined;
          }
          policyFor() {
            return "never" as const;
          }
          schemasFor() {
            return [];
          }
          // biome-ignore lint/suspicious/noExplicitAny: minimal registry stand-in
        })() as any,
        emit: (events: EventEnvelope[]) => emit(events),
      }),
  });
});
afterEach(async () => {
  await supervisor.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const start = (runId: string, lane: string) =>
  supervisor.startRun({
    run_id: runId,
    session_id: "45",
    lane,
    repo_path: dir,
    prompt: "go",
    requested_by: "7",
    provider: "anthropic-direct",
    model: "m",
  });

const lanesOf = () =>
  supervisor
    .activeRuns()
    .map((r) => r.lane)
    .sort();

describe("two lanes in one session", () => {
  it("both appear as active", async () => {
    await start("run_a", "main");
    await start("run_b", "review");

    expect(lanesOf()).toEqual(["main", "review"]);
  });

  it("interrupting one leaves the other RUNNING", async () => {
    await start("run_a", "main");
    await start("run_b", "review");

    await supervisor.interrupt("run_a");

    // The failure this rules out: an abort or a store release that reached shared state would take
    // both lanes down, and the participant who interrupted one would have stopped someone else's
    // work.
    expect(lanesOf()).toEqual(["review"]);
  });

  it("leaves the surviving lane interruptible on its own terms", async () => {
    await start("run_a", "main");
    await start("run_b", "review");
    await supervisor.interrupt("run_a");

    await expect(supervisor.interrupt("run_b")).resolves.toBeUndefined();
    expect(lanesOf()).toEqual([]);
  });

  it("keeps the SHARED store open while the other lane still holds it", async () => {
    await start("run_a", "main");
    await start("run_b", "review");
    await supervisor.interrupt("run_a");

    // Refcounted per session: closing on the first release would leave the surviving lane writing
    // to a closed store, which is how the concurrent-lane test failed before the refcount existed.
    await expect(start("run_c", "third")).resolves.toBeUndefined();
    expect(lanesOf()).toEqual(["review", "third"]);
  });

  // The RECORD side of release — `lane.state` going null for the interrupted lane while the other
  // stays held — is covered directly in `concurrent.test.ts`, which can read the registers without
  // reaching through a shut-down supervisor. Asserting it here from `activeRuns()` would only
  // restate the test above under a name that claims more than it checks.
});

describe("one lane refuses a second run", () => {
  it("rejects a second start in the SAME lane while the first is live", async () => {
    await start("run_a", "main");

    await expect(start("run_a2", "main")).rejects.toThrow(/lane main already has an active run/);
  });

  it("still accepts the other lane after that refusal", async () => {
    await start("run_a", "main");
    await start("run_a2", "main").catch(() => undefined);

    await expect(start("run_b", "review")).resolves.toBeUndefined();
    expect(lanesOf()).toEqual(["main", "review"]);
  });
});
