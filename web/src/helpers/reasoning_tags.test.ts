import { describe, expect, it } from "vitest";
import { splitReasoning } from "./reasoning_tags";

// The real thing, from the committed capture of us.amazon.nova-lite-v1:0 asked to read a file
// (`harness/test/fixtures/converse/nova-tool-use.json`). The ENTIRE visible text of that turn is
// the monologue; the answer was a tool call.
const NOVA =
  "<thinking>The User has asked to read the contents of a file located at /tmp/notes.txt. " +
  "I have the appropriate tool to read the file from the disk. I will use the `read_file` tool " +
  "with the path specified by the User.</thinking>\n";

describe("splitReasoning", () => {
  it("leaves ordinary text completely alone", () => {
    expect(splitReasoning("Just an answer.")).toEqual([
      { kind: "answer", text: "Just an answer." },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(splitReasoning("")).toEqual([]);
  });

  it("pulls Nova's monologue out of the answer, tags and all", () => {
    const segments = splitReasoning(NOVA);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("reasoning");
    expect(segments[0]?.text).toContain("read the contents of a file");
    // The tags themselves are structure, not content — they must not reach the reader.
    expect(segments[0]?.text).not.toContain("<thinking>");
    expect(segments[0]?.text).not.toContain("</thinking>");
  });

  it("keeps reasoning and answer in the order they were written", () => {
    expect(splitReasoning("<thinking>weighing it</thinking>The answer is 4.")).toEqual([
      { kind: "reasoning", text: "weighing it" },
      { kind: "answer", text: "The answer is 4." },
    ]);
  });

  it("handles an answer that comes BEFORE the reasoning", () => {
    expect(splitReasoning("Sure.<thinking>but why</thinking>")).toEqual([
      { kind: "answer", text: "Sure." },
      { kind: "reasoning", text: "but why" },
    ]);
  });

  it("handles several spans in one block", () => {
    expect(splitReasoning("<thinking>a</thinking>one<thinking>b</thinking>two")).toEqual([
      { kind: "reasoning", text: "a" },
      { kind: "answer", text: "one" },
      { kind: "reasoning", text: "b" },
      { kind: "answer", text: "two" },
    ]);
  });

  it("treats an UNCLOSED tag as reasoning-so-far, which is every streaming frame", () => {
    // The live case: the closing tag has not arrived yet. Without this the whole monologue
    // renders as the answer for as long as the model is still writing it.
    expect(splitReasoning("<thinking>still going")).toEqual([
      { kind: "reasoning", text: "still going" },
    ]);
  });

  it("holds back a trailing fragment that is the start of a tag", () => {
    // A delta boundary can land inside the tag itself; `<thi` must not flash on screen.
    expect(splitReasoning("Answer.<thi")).toEqual([{ kind: "answer", text: "Answer." }]);
    expect(splitReasoning("Answer.<")).toEqual([{ kind: "answer", text: "Answer." }]);
  });

  it("keeps an angle bracket that is NOT a tag prefix", () => {
    expect(splitReasoning("if a < b then")).toEqual([{ kind: "answer", text: "if a < b then" }]);
    expect(splitReasoning("use <div> here")).toEqual([{ kind: "answer", text: "use <div> here" }]);
  });

  it("drops whitespace-only segments rather than rendering empty boxes", () => {
    expect(splitReasoning("<thinking>  </thinking>\n\n")).toEqual([]);
  });

  it("does not mangle a legitimate mention of the tag — it relocates it", () => {
    // A model explaining the convention gets that passage in a reasoning box. Nothing is lost;
    // the box renders expanded. Deleting the text is the failure mode this avoids.
    const segments = splitReasoning("Models write <thinking>like this</thinking> to reason.");
    expect(segments.map((s) => s.text).join(" ")).toContain("like this");
    expect(segments).toHaveLength(3);
  });
});
