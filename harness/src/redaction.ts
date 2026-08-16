/**
 * Redaction, bounding, and tool-input summarizing — the safety helpers that outlive
 * whatever engine is underneath.
 *
 * Extracted from the SDK-era `normalizer.ts` when that file was retired: none of
 * this was ever SDK-specific, and the rules are load-bearing enough that they
 * should not have shared a file with a vendor mapping.
 */

export const AI_RAW_CAP_BYTES = 8 * 1024;
export const TOOL_INPUT_SUMMARY_CAP = 500;

const CREDENTIAL_KEY =
  /(api[_-]?key|token|secret|authorization|bearer|password|passwd|pwd|credential|private[_-]?key|aws[_-]?(secret|access)[_-]?key)/i;
const REDACTED = "[REDACTED]";

/** Redact by KEY NAME, recursively. Values are never pattern-matched — a key
 *  called `token` is redacted whatever it holds, which is the safer default than
 *  guessing whether a string looks like a secret. */
export function redactCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = CREDENTIAL_KEY.test(key) ? REDACTED : redactCredentials(val);
    }
    return out;
  }
  return value;
}

/**
 * Redact FIRST, then truncate to the 8KB cap. The order is load-bearing:
 * truncating first can slice a secret in half and leave the front of it in the
 * record.
 *
 * NEVER THROWS, and that is the whole point of the `ai_raw` valve. This is the fallback
 * the normalizer reaches for when a mapping fails, so it is handed exactly the values
 * that already broke something — and it used to break on them too: walking and
 * JSON-stringifying an untrusted object re-triggers a throwing getter, blows the stack on
 * a cycle, and refuses a BigInt outright. A fallback that fails on its own input is not a
 * fallback, and the run died with a provider error instead of recording an `ai_raw`.
 *
 * A value it cannot serialize degrades to a NAMED marker rather than `{}`: "this could not
 * be serialized" and "the provider sent nothing" are different facts, and a reader who
 * cannot tell them apart is looking in the wrong place.
 */
export function boundRawPayload(raw: unknown): { raw: unknown; truncated: boolean } {
  let redacted: unknown;
  let serialized: string;
  try {
    redacted = redactCredentials(raw);
    serialized = JSON.stringify(redacted) ?? "";
  } catch (err) {
    return { raw: { unserializable: String(err).slice(0, 300) }, truncated: true };
  }

  if (Buffer.byteLength(serialized, "utf8") <= AI_RAW_CAP_BYTES) {
    return { raw: redacted, truncated: false };
  }
  const sliced = Buffer.from(serialized, "utf8").subarray(0, AI_RAW_CAP_BYTES).toString("utf8");
  return { raw: { truncated_serialized: sliced }, truncated: true };
}

/**
 * Summarize a tool input to path/command form, capped at 500 chars — NEVER the
 * full payload. A `create` carrying a whole file would otherwise put the file's
 * contents in the feed and in every projection of it.
 *
 * Handles both vocabularies: the canonical schema-less tools use `path` +
 * `command`, while the Agent-SDK-era names used `file_path`. Both are accepted
 * because a run recorded before the swap must still summarize correctly when its
 * transcript is re-read.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const command = String(obj.command ?? "");
  let summary: string;

  if (name === "bash" || name === "Bash") {
    const description = obj.description ? ` — ${String(obj.description)}` : "";
    summary = `${command}${description}`;
  } else if (obj.path !== undefined || obj.file_path !== undefined) {
    const path = String(obj.path ?? obj.file_path ?? "");
    summary = command === "" ? path : `${command} ${path}`;
  } else {
    summary = JSON.stringify(obj);
  }
  return summary.slice(0, TOOL_INPUT_SUMMARY_CAP);
}

/** ISO-8601 UTC, millisecond precision, Z suffix. Display-only. */
export function isoMs(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 23)}Z`;
}
