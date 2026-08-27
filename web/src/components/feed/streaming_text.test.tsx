import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StreamingText } from "./streaming_text";

// Nova narrates its reasoning inside the answer text, so the participant used to watch
// `<thinking>` tags stream in as if they were the reply. The record keeps them; the renderer
// separates them, live and once settled alike.
describe("StreamingText", () => {
  it("shows plain streaming text as the answer", () => {
    render(<StreamingText text="Hello there" />);
    expect(screen.getByTestId("feed-streaming-text")).toHaveTextContent("Hello there");
    expect(screen.queryByTestId("feed-thinking")).toBeNull();
  });

  it("routes an inline <thinking> span to a reasoning block, tags removed", () => {
    render(<StreamingText text="<thinking>I will read the file</thinking>Here it is." />);

    expect(screen.getByTestId("feed-thinking")).toHaveTextContent("I will read the file");
    expect(screen.getByTestId("feed-streaming-text")).toHaveTextContent("Here it is.");
    expect(screen.getByTestId("feed-thinking")).not.toHaveTextContent("<thinking>");
  });

  it("shows an UNCLOSED span as reasoning while the model is still writing it", () => {
    // The whole point of doing this at render time: mid-stream there is no closing tag yet.
    render(<StreamingText text="<thinking>still weighing" />);

    expect(screen.getByTestId("feed-thinking")).toHaveTextContent("still weighing");
    expect(screen.queryByTestId("feed-streaming-text")).toBeNull();
  });

  it("does not flash a half-arrived tag", () => {
    render(<StreamingText text="Done.<thi" />);
    expect(screen.getByTestId("feed-streaming-text")).toHaveTextContent("Done.");
    expect(screen.getByTestId("feed-streaming-text")).not.toHaveTextContent("<thi");
  });

  it("renders nothing at all for a block that has only whitespace so far", () => {
    const { container } = render(<StreamingText text="" />);
    expect(container.textContent).toBe("");
  });
});
