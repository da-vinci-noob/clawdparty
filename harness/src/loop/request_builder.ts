import type {
  Capabilities,
  NeutralMessage,
  ProviderRequest,
  SystemBlock,
  ToolSchema,
} from "../providers/contract.js";
import type { EffortLevel } from "../providers/contract.js";
import type { Entry } from "../store/types.js";

/**
 * Builds a `ProviderRequest` by folding a PURE function over the record's surface.
 *
 * Purity is the point : the same entries always produce the same
 * request, so any request the harness sent can be reconstructed from the record
 * alone. Prefix-stability for prompt caching then comes out for free — an
 * append-only record projected by a per-entry pure function yields requests that
 * are append-extensions of their predecessors. That is a corollary, not the goal.
 */

/**
 * Cache breakpoints walk back AT MOST 20 content blocks to find a prior entry. A
 * single tool-heavy turn routinely adds more than 20, which means the next
 * request's breakpoint finds nothing and SILENTLY MISSES THE CACHE — no error,
 * just cost. Hence an intermediate breakpoint every ~15 blocks, comfortably inside
 * the lookback.
 */
export const CACHE_BREAKPOINT_INTERVAL = 15;
export const CACHE_LOOKBACK_BLOCKS = 20;
/** The API allows at most 4. The last is reserved for the live tail. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Headroom reserved for thinking on top of the expected answer.
 *
 * `max_tokens` caps thinking PLUS text together, and on `claude-opus-5` thinking
 * is ON by default when `thinking` is omitted. A run sized around the answer alone
 * truncates mid-response once thinking is on — which reads as a model failure
 * rather than a configuration one.
 */
export const THINKING_HEADROOM_TOKENS = 8_192;
export const DEFAULT_ANSWER_TOKENS = 8_192;

export interface BuildInput {
  model: string;
  capabilities: Capabilities;
  systemPrompt: string;
  tools: ToolSchema[];
  /** `surfaceFrom(0)` — entries with `on_surface = 1`, in order. */
  surface: Entry[];
  effort?: EffortLevel;
  answerTokens?: number;
  signal: AbortSignal;
}

export function build(input: BuildInput): ProviderRequest {
  const messages = foldSurface(input.surface);
  const cacheBreakpoints = input.capabilities.promptCaching
    ? placeBreakpoints(countBlocks(messages))
    : [];

  const request: ProviderRequest = {
    model: input.model,
    maxTokens: sizeMaxTokens(input),
    system: buildSystem(input.systemPrompt, input.capabilities),
    messages,
    tools: input.tools,
    ...thinkingFor(input.capabilities),
    ...(input.effort && input.capabilities.effortLevels.includes(input.effort)
      ? { effort: input.effort }
      : {}),
    ...(input.capabilities.serverSideCompaction ? { compaction: true } : {}),
    cacheBreakpoints,
    signal: input.signal,
  };

  return deepFreezeExceptSignal(request);
}

/**
 * Fold entries into provider messages, carrying content blocks VERBATIM.
 *
 * Never flattens to text. A `compaction` block is what the API uses to replace
 * compacted history on the next request, and a `thinking` block must be echoed
 * back unedited or it is rejected — so extracting text would silently break the
 * conversation one turn later, which is the worst kind of bug to own.
 *
 * Consecutive entries with the same role merge into one message. Tool results in
 * particular MUST arrive in a single user message: splitting them across several
 * silently trains the model to stop making parallel calls.
 */
export function foldSurface(surface: Entry[]): NeutralMessage[] {
  // Every tool id that has BOTH halves somewhere on the surface. A `tool_use` or `tool_result`
  // whose id is not paired is an ORPHAN, and every provider 400s on one — so it is dropped
  // here rather than sent. Orphans arise whenever a run terminates between a tool call
  // and its result (interrupt, provider_error, a mid-turn failure), and once on the surface
  // they poison every later turn; dropping at the fold is provider-agnostic, catches the
  // orphan whatever caused it, and SELF-HEALS a session that already holds one.
  const paired = pairedToolIds(surface);
  const messages: NeutralMessage[] = [];

  for (const entry of surface) {
    if (entry.blocks === null || entry.blocks.length === 0) continue;
    const kept = entry.blocks.filter((block) => {
      const id = toolBlockId(block);
      return id === null || paired.has(id);
    });
    // A message whose only blocks were orphans is dropped whole — an empty content array is
    // itself a 400.
    if (kept.length === 0) continue;

    const role = roleFor(entry);
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...kept);
    else messages.push({ role, content: [...kept] });
  }
  return messages;
}

/** Tool ids that have a `tool_use` AND a matching `tool_result` somewhere on the surface. */
function pairedToolIds(surface: Entry[]): Set<string> {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const entry of surface) {
    for (const block of entry.blocks ?? []) {
      const use = toolUseId(block);
      if (use !== null) uses.add(use);
      const result = toolResultId(block);
      if (result !== null) results.add(result);
    }
  }
  const paired = new Set<string>();
  for (const id of uses) if (results.has(id)) paired.add(id);
  return paired;
}

/** The tool id a block carries as either half of a call, or null if it is not a tool block. */
function toolBlockId(block: unknown): string | null {
  return toolUseId(block) ?? toolResultId(block);
}

function toolUseId(block: unknown): string | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  // Anthropic-shaped, and the canonical shape the Converse mapper now emits.
  if (b.type === "tool_use" && typeof b.id === "string") return b.id;
  // Legacy Converse-shaped block on a surface written before the canonical shape landed.
  const toolUse = b.toolUse as { toolUseId?: unknown } | undefined;
  if (toolUse && typeof toolUse.toolUseId === "string") return toolUse.toolUseId;
  return null;
}

function toolResultId(block: unknown): string | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b.type === "tool_result" && typeof b.tool_use_id === "string") return b.tool_use_id;
  const toolResult = b.toolResult as { toolUseId?: unknown } | undefined;
  if (toolResult && typeof toolResult.toolUseId === "string") return toolResult.toolUseId;
  return null;
}

function roleFor(entry: Entry): "user" | "assistant" {
  // Claude's own output is assistant; everything else on the surface — the human's
  // prompt and tool results the harness produced — is user.
  return entry.actor_kind === "claude" ? "assistant" : "user";
}

function buildSystem(prompt: string, caps: Capabilities): SystemBlock[] {
  const block: SystemBlock = { type: "text", text: prompt };
  // The system prompt is the most stable prefix there is, so it earns a
  // breakpoint whenever it is long enough to be cacheable at all. Below the
  // model's minimum the marker is ignored, so setting it is not free — it costs a
  // wasted breakpoint out of four.
  if (caps.promptCaching && exceedsMinimum(prompt, caps)) {
    block.cache_control = { type: "ephemeral" };
  }
  return [block];
}

function exceedsMinimum(prompt: string, caps: Capabilities): boolean {
  const minimum = caps.minCacheablePrefixTokens;
  if (minimum === null) return true;
  // ~4 chars per token is enough precision to decide whether to spend a marker.
  return prompt.length / 4 >= minimum;
}

/**
 * Never emits `budget_tokens` — it returns 400 on current models. `display` is set
 * EXPLICITLY to `summarized` because it defaults to `omitted`, which streams
 * thinking blocks with empty text; the feed would show a long pause and then
 * nothing, since clawdparty renders thinking live.
 */
function thinkingFor(caps: Capabilities): Pick<ProviderRequest, "thinking"> {
  if (!caps.adaptiveThinking) return {};
  return {
    thinking: {
      type: "adaptive",
      display: caps.thinkingDisplaySummarized ? "summarized" : "omitted",
    },
  };
}

/** Sizes for thinking AND text together, then clamps to the model's ceiling. */
export function sizeMaxTokens(input: Pick<BuildInput, "capabilities" | "answerTokens">): number {
  const answer = input.answerTokens ?? DEFAULT_ANSWER_TOKENS;
  const headroom = input.capabilities.adaptiveThinking ? THINKING_HEADROOM_TOKENS : 0;
  return Math.min(answer + headroom, input.capabilities.maxOutputTokens);
}

export function countBlocks(messages: NeutralMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

/**
 * Block indices to mark, spaced by `CACHE_BREAKPOINT_INTERVAL` and capped at
 * `MAX_CACHE_BREAKPOINTS`. When there are more candidates than slots the LATEST
 * are kept: the newest prefix is the one the next request will match against, so
 * dropping old markers costs nothing while dropping recent ones costs the cache.
 */
export function placeBreakpoints(blockCount: number): number[] {
  if (blockCount === 0) return [];

  const candidates: number[] = [];
  for (let at = CACHE_BREAKPOINT_INTERVAL - 1; at < blockCount; at += CACHE_BREAKPOINT_INTERVAL) {
    candidates.push(at);
  }
  const tail = blockCount - 1;
  if (candidates.at(-1) !== tail) candidates.push(tail);

  return candidates.slice(-MAX_CACHE_BREAKPOINTS);
}

/**
 * Fingerprint of a value the record references but does not copy.
 *
 * 32-bit and not cryptographic, which is sufficient because the job is ACCIDENT
 * detection — "is the system prompt in the code still the one this run used?" — and not
 * tamper detection. The record is a local file the developer already owns outright, so
 * there is no attacker to raise the bar against. Lives here rather than in the loop
 * because reconstruction is what the digest exists FOR, and the two must agree.
 */
export function digest(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return `djb2:${(hash >>> 0).toString(16)}`;
}

/** The `request_header` payload, as the record stores it. */
export interface RequestSnapshot {
  provider: string;
  model: string;
  effort: EffortLevel | null;
  system_prompt_digest: string;
  tool_schemas_digest: string;
}

export interface ReconstructInput {
  /**
   * A LOG PREFIX in store order — every entry up to the point being rebuilt. Not
   * pre-filtered: the fold needs the surface entries and the snapshot needs the
   * `request_header`s, and making the caller separate them is how the two get
   * misaligned.
   */
  entries: Entry[];
  /**
   * The two values the record holds only as a digest. Supplied rather than recorded
   * because a system prompt restated on every turn would dwarf the turn itself; the
   * digest is what makes supplying them safe, since a stale one is REFUSED below
   * instead of silently producing a request the run never sent.
   */
  systemPrompt: string;
  tools: ToolSchema[];
  capabilities: Capabilities;
  signal: AbortSignal;
  answerTokens?: number;
}

export type ReconstructResult =
  | { ok: true; request: ProviderRequest; snapshot: RequestSnapshot }
  | { ok: false; reason: "no_snapshot" }
  | {
      ok: false;
      reason: "digest_mismatch";
      field: "system_prompt" | "tool_schemas";
      recorded: string;
      supplied: string;
    };

/**
 * Rebuild the request a log prefix implies.
 *
 * Delegates the whole construction to `build`, which is what makes "no two paths can
 * disagree" true rather than asserted — a reconstruction that re-implemented the fold
 * would drift the first time a cache rule or a thinking default changed, and it would
 * drift SILENTLY because both sides would look reasonable.
 *
 * `model`, `effort` and `provider` come from the RECORD, never from a caller's live
 * config. That is the direction that matters: reading them from live state would make
 * the reconstruction describe the machine it runs on instead of the run it replays.
 *
 * The snapshot used is the LAST `request_header` at or before the end of the prefix,
 * matching emit-on-change semantics — a header is written when established or changed,
 * so folding forward to the latest one is what reproduces the turn's real configuration.
 */
export function reconstruct(input: ReconstructInput): ReconstructResult {
  const snapshot = latestSnapshot(input.entries);
  if (!snapshot) return { ok: false, reason: "no_snapshot" };

  const promptDigest = digest(input.systemPrompt);
  if (promptDigest !== snapshot.system_prompt_digest) {
    return {
      ok: false,
      reason: "digest_mismatch",
      field: "system_prompt",
      recorded: snapshot.system_prompt_digest,
      supplied: promptDigest,
    };
  }

  const toolsDigest = digest(JSON.stringify(input.tools));
  if (toolsDigest !== snapshot.tool_schemas_digest) {
    return {
      ok: false,
      reason: "digest_mismatch",
      field: "tool_schemas",
      recorded: snapshot.tool_schemas_digest,
      supplied: toolsDigest,
    };
  }

  const request = build({
    model: snapshot.model,
    capabilities: input.capabilities,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    surface: input.entries.filter((entry) => entry.on_surface === 1),
    ...(snapshot.effort ? { effort: snapshot.effort } : {}),
    ...(input.answerTokens === undefined ? {} : { answerTokens: input.answerTokens }),
    signal: input.signal,
  });

  return { ok: true, request, snapshot };
}

function latestSnapshot(entries: Entry[]): RequestSnapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "request_header") return entry.payload as RequestSnapshot;
  }
  return null;
}

/**
 * Deep-freeze so mutating a built request THROWS  — a request the record
 * cannot explain becomes impossible to construct by accident rather than merely
 * discouraged.
 *
 * `signal` is skipped deliberately: it is live, and freezing an AbortSignal breaks
 * abort. It is the one documented non-frozen field on ProviderRequest.
 */
export function deepFreezeExceptSignal<T extends object>(value: T): T {
  for (const [key, child] of Object.entries(value)) {
    if (key === "signal") continue;
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreezeExceptSignal(child as object);
    }
  }
  return Object.freeze(value);
}
