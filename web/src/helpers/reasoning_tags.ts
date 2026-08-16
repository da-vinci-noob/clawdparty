export interface TextSegment {
  kind: "answer" | "reasoning";
  text: string;
}

const OPEN = "<thinking>";
const CLOSE = "</thinking>";

/**
 * Split model text into answer and reasoning parts.
 *
 * Amazon Nova narrates its reasoning as a literal `<thinking>…</thinking>` span inside an
 * ORDINARY text block — not a protocol carrier like Anthropic's thinking blocks or OpenAI's
 * encrypted `reasoningContent`, just tagged prose mixed in with the answer. Left alone it
 * renders as the answer, so a Nova turn shows the participant its internal monologue wrapped in
 * XML (measured: `harness/test/fixtures/converse/nova-tool-use.json` is nothing but one).
 *
 * This is a DISPLAY decision, made here rather than in the harness for a reason the harness
 * cannot get around: the tag arrives split across streamed deltas that were already broadcast,
 * and an ephemeral delta cannot be retracted. Reclassifying mid-stream would mean buffering text
 * until a `<` resolves — reintroducing the "nothing appears until the turn settles" defect that
 * was already fixed once. So the record stays verbatim and the renderer decides.
 *
 * A false positive is therefore benign BY CONSTRUCTION: any model discussing `<thinking>` tags
 * in prose (plausible in this repo) gets that passage in an expanded reasoning box, not deleted.
 */
export function splitReasoning(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  if (!text.includes(OPEN)) {
    push(segments, "answer", text);
    return segments;
  }

  let at = 0;
  while (at < text.length) {
    const open = text.indexOf(OPEN, at);
    if (open === -1) {
      push(segments, "answer", text.slice(at));
      break;
    }
    push(segments, "answer", text.slice(at, open));

    const bodyFrom = open + OPEN.length;
    const close = text.indexOf(CLOSE, bodyFrom);
    if (close === -1) {
      // Still streaming: everything after an unclosed tag is reasoning so far.
      push(segments, "reasoning", text.slice(bodyFrom));
      break;
    }
    push(segments, "reasoning", text.slice(bodyFrom, close));
    at = close + CLOSE.length;
  }
  return segments;
}

function push(into: TextSegment[], kind: TextSegment["kind"], text: string): void {
  const trimmed = kind === "answer" ? holdPartialTag(text) : text;
  if (trimmed.trim() !== "") {
    into.push({ kind, text: trimmed });
  }
}

/**
 * Drop a trailing fragment that is the START of `<thinking>`.
 *
 * Mid-stream the accumulator ends anywhere, including on `<thi`. Rendering that shows the
 * participant a stray angle bracket for one frame before it becomes a tag and disappears.
 */
function holdPartialTag(text: string): string {
  const last = text.lastIndexOf("<");
  if (last === -1) {
    return text;
  }
  const tail = text.slice(last);
  return OPEN.startsWith(tail) ? text.slice(0, last) : text;
}
