import type { EventEnvelope } from "@clawdparty/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextBlock } from "./text_block";

// Build a durable ai_text event carrying the given markdown as its text payload.
function aiText(text: string): EventEnvelope {
  return {
    id: 1,
    session_id: "sess_demo",
    ai_run_id: "run_demo",
    seq: 1,
    type: "ai_text",
    actor: { kind: "claude" },
    ts: "2026-06-28T20:11:00.000Z",
    payload: { block: "b:0", text },
  };
}

describe("TextBlock (markdown rendering)", () => {
  it("renders **bold** as a <strong>, not literal asterisks", () => {
    render(<TextBlock event={aiText("this is **bold** text")} />);
    const block = screen.getByTestId("feed-text");
    const strong = within(block).getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    expect(block).not.toHaveTextContent("**bold**");
  });

  it("renders inline `code` as a <code> element", () => {
    render(<TextBlock event={aiText("call `render()` now")} />);
    const block = screen.getByTestId("feed-text");
    const code = within(block).getByText("render()");
    expect(code.tagName).toBe("CODE");
    expect(block).not.toHaveTextContent("`render()`");
  });

  it("renders a fenced code block as a <pre><code>", () => {
    render(<TextBlock event={aiText("```\nconst x = 1;\n```")} />);
    const block = screen.getByTestId("feed-text");
    const code = within(block).getByText(/const x = 1;/);
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).not.toBeNull();
  });

  it("renders a `- item` bullet as a list item inside a <ul>", () => {
    render(<TextBlock event={aiText("- first\n- second")} />);
    const block = screen.getByTestId("feed-text");
    const items = within(block).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [first] = items;
    expect(first?.tagName).toBe("LI");
    expect(first?.closest("ul")).not.toBeNull();
    expect(block).not.toHaveTextContent("- first");
  });

  it("renders `## Heading` as a real heading element", () => {
    render(<TextBlock event={aiText("## Section title")} />);
    const heading = screen.getByRole("heading", { name: "Section title" });
    expect(heading.tagName).toBe("H2");
    expect(screen.getByTestId("feed-text")).not.toHaveTextContent("## Section title");
  });

  it("renders a GFM table (remark-gfm) with real table cells", () => {
    render(<TextBlock event={aiText("| a | b |\n| - | - |\n| 1 | 2 |")} />);
    const block = screen.getByTestId("feed-text");
    expect(within(block).getByRole("table")).toBeInTheDocument();
    expect(within(block).getAllByRole("columnheader")).toHaveLength(2);
  });

  it("keeps the feed-text testid so the feed can still find the block", () => {
    render(<TextBlock event={aiText("plain paragraph")} />);
    expect(screen.getByTestId("feed-text")).toHaveTextContent("plain paragraph");
  });
});

describe("reasoning narrated inside the answer", () => {
  // Nova's whole visible turn, from the committed Bedrock capture. Rendered as-is it showed the
  // participant the model's monologue wrapped in XML and called it the answer.
  const NOVA =
    "<thinking>The User has asked to read the contents of a file located at /tmp/notes.txt. " +
    "I will use the `read_file` tool.</thinking>\n";

  it("moves an inline <thinking> span into a reasoning block", () => {
    render(<TextBlock event={aiText(NOVA)} />);

    expect(screen.getByTestId("feed-thinking")).toHaveTextContent("read the contents of a file");
    expect(screen.queryByTestId("feed-text")).toBeNull();
  });

  it("still renders the answer as markdown alongside it", () => {
    render(<TextBlock event={aiText("<thinking>weighing</thinking>The answer is **4**.")} />);

    expect(screen.getByTestId("feed-thinking")).toHaveTextContent("weighing");
    const answer = screen.getByTestId("feed-text");
    expect(answer).toHaveTextContent("The answer is 4.");
    expect(answer).not.toHaveTextContent("**4**");
  });

  it("leaves text with no reasoning span on the single-markdown path", () => {
    render(<TextBlock event={aiText("just **an answer**")} />);
    expect(screen.queryByTestId("feed-thinking")).toBeNull();
    expect(screen.getByTestId("feed-text")).toHaveTextContent("just an answer");
  });
});
