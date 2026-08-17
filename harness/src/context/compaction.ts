import type { Capabilities } from "../providers/contract.js";

/**
 * Server-side context compaction.
 *
 * The provider summarises the conversation on its own side and returns a `compaction` content
 * block; the next request carries that block instead of the span it replaced. The harness's job
 * is only to ASK for it and to carry the block back verbatim — it never summarises anything
 * itself, which is what keeps a compacted session reconstructable from the record.
 *
 * **This module exists because `ProviderRequest.compaction` was a setting nothing read.**
 * `request_builder` has set it since M4 whenever `capabilities().serverSideCompaction` was true,
 * and no adapter translated it into anything — the three Anthropic `stream()` calls simply
 * omitted it. So a session driven past the window would have hit
 * `model_context_window_exceeded`, been mapped to `{kind:"compact"}`, looped, and hit the same
 * wall again, because nothing had ever requested compaction. The loop's retry was correct and
 * the request it retried was not.
 *
 * **Verification status, stated plainly: the live path is UNVERIFIED.** This host serves neither
 * first-party Anthropic path (no API key, no OAuth token) and `anthropic-bedrock` declares
 * `serverSideCompaction: false` — the SDK says Bedrock has no such support. So the directive
 * below is built from the documented shape and gated so it is only ever sent to a model that
 * reported supporting that exact edit type. Everything downstream of the request (carrying the
 * block back, emitting `context_compacted`, rendering it) IS testable and is tested.
 */

/** The edit type and its beta, together — sending one without the other is a 400. */
export const COMPACTION_EDIT_TYPE = "compact_20260112";
export const COMPACTION_BETA = "compact-2026-01-12";

export interface CompactionDirective {
  context_management: { edits: Array<{ type: string }> };
  betas: string[];
}

/**
 * The vendor directive, or `undefined` when compaction must not be requested.
 *
 * Two conditions, and BOTH are required: the caller asked (`request.compaction`, which
 * `request_builder` sets from the capability) and the model reported the capability. The second
 * check is not redundant — it is what makes a stale or hand-built request safe, and asking a
 * model that does not support the edit type is a 400 that fails the whole turn rather than
 * degrading.
 */
export function compactionDirective(
  capabilities: Pick<Capabilities, "serverSideCompaction">,
  requested: boolean | undefined,
): CompactionDirective | undefined {
  if (!requested || !capabilities.serverSideCompaction) {
    return undefined;
  }
  return {
    context_management: { edits: [{ type: COMPACTION_EDIT_TYPE }] },
    betas: [COMPACTION_BETA],
  };
}

/**
 * Whether a block TYPE is a compaction block.
 *
 * One definition, imported by both places that classify blocks (`anthropic_family.blockKind` and
 * `normalize.inferKind`) — they had a copy each, and an unrecognised compaction block is dropped
 * history, which is the most expensive failure this feature has.
 *
 * Prefix-matched rather than compared to `COMPACTION_EDIT_TYPE`: the block type the API returns is
 * versioned independently of the edit type requested, so pinning them to each other would make
 * the next version of either silently stop being recognised.
 */
export function isCompactionType(type: string): boolean {
  return type.startsWith("compaction");
}
