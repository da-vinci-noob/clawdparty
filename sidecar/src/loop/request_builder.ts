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
  const messages: NeutralMessage[] = [];

  for (const entry of surface) {
    if (entry.blocks === null || entry.blocks.length === 0) continue;
    const role = roleFor(entry);
    const last = messages.at(-1);

    if (last && last.role === role) last.content.push(...entry.blocks);
    else messages.push({ role, content: [...entry.blocks] });
  }
  return messages;
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
