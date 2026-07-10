import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@clawdparty/contracts";
import { describe, expect, it } from "vitest";
import { Normalizer } from "../src/normalizer.js";

const ctx = { sessionId: "sess_demo", aiRunId: "run_demo", requestedBy: "part_alice" };

function normalizeAll(raw: unknown[]): EventEnvelope[] {
  const n = new Normalizer(ctx);
  return raw.flatMap((m) => n.normalize(m, 0));
}

function first(events: EventEnvelope[]): EventEnvelope {
  const e = events[0];
  if (!e) throw new Error("expected at least one event");
  return e;
}

describe("normalizer full per-type mapping (spike-derived)", () => {
  it("maps system/init → run_started with model/cwd/permission_mode/claude_session_id", () => {
    const ev = first(
      normalizeAll([
        {
          type: "system",
          subtype: "init",
          model: "m",
          cwd: "/repo",
          permissionMode: "acceptEdits",
          session_id: "sdk-1",
        },
      ]),
    );
    expect(ev.type).toBe("run_started");
    expect(ev.actor).toEqual({ kind: "user", id: "part_alice" });
    expect(ev.payload).toMatchObject({
      model: "m",
      cwd: "/repo",
      permission_mode: "acceptEdits",
      claude_session_id: "sdk-1",
    });
  });

  it("maps assistant text → durable ai_text and thinking → ai_thinking", () => {
    const out = normalizeAll([
      {
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "hmm" },
          ],
        },
      },
    ]);
    expect(out.map((e) => e.type)).toEqual(["ai_text", "ai_thinking"]);
    expect(first(out).payload).toMatchObject({ block: "u1:0", text: "hello" });
  });

  it("durable ai_thinking carries the accumulated thinking_delta text when the final block is empty", () => {
    // The real SDK's finalized `thinking` block is signature-only (thinking: "");
    // the text arrives ONLY via streaming thinking_deltas. The durable ai_thinking
    // must reconstruct the full text from those deltas, else the UI block is empty.
    const out = normalizeAll([
      {
        type: "stream_event",
        uuid: "u1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me " },
        },
      },
      {
        type: "stream_event",
        uuid: "u1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think about it" },
        },
      },
      { type: "assistant", uuid: "u1", message: { content: [{ type: "thinking", thinking: "" }] } },
    ]);
    const durable = out.find((e) => e.type === "ai_thinking");
    expect(durable?.payload).toMatchObject({ block: "u1:0", text: "let me think about it" });
  });

  it("durable ai_thinking prefers a non-empty block.thinking over accumulated deltas", () => {
    const out = normalizeAll([
      {
        type: "stream_event",
        uuid: "u9",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "partial" },
        },
      },
      {
        type: "assistant",
        uuid: "u9",
        message: { content: [{ type: "thinking", thinking: "full thought" }] },
      },
    ]);
    const durable = out.find((e) => e.type === "ai_thinking");
    expect(durable?.payload).toMatchObject({ block: "u9:0", text: "full thought" });
  });

  it("maps tool_use → tool_started with SUMMARIZED input (never the full payload) + file_changed for Write", () => {
    const out = normalizeAll([
      {
        type: "assistant",
        uuid: "u2",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Write",
              input: { file_path: "a.txt", content: "x".repeat(5000) },
            },
          ],
        },
      },
    ]);
    const started = out.find((e) => e.type === "tool_started");
    expect((started?.payload as { input_summary: string }).input_summary).toBe("a.txt");
    expect(JSON.stringify(started?.payload)).not.toContain("xxxxx"); // full content never carried
    expect(out.find((e) => e.type === "file_changed")?.payload).toMatchObject({
      path: "a.txt",
      change: "created",
    });
  });

  it("maps a Bash tool_result → terminal_output then tool_finished", () => {
    const out = normalizeAll([
      {
        type: "assistant",
        uuid: "u3",
        message: {
          content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "b1", content: "file.txt\n", is_error: false },
          ],
        },
      },
    ]);
    const types = out.map((e) => e.type);
    expect(types).toContain("terminal_output");
    expect(types).toContain("tool_finished");
    expect(out.find((e) => e.type === "terminal_output")?.payload).toMatchObject({
      chunk_index: 0,
      text: "file.txt\n",
    });
  });

  it("maps an error tool_result → tool_failed", () => {
    const out = normalizeAll([
      {
        type: "assistant",
        uuid: "u4",
        message: {
          content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "a" } }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "w1", content: "boom", is_error: true }],
        },
      },
    ]);
    const failed = out.find((e) => e.type === "tool_failed");
    expect(failed?.payload).toMatchObject({ ok: false, error: "boom" });
  });

  it("maps result/success → run_finished (system) carrying total_cost_usd + usage", () => {
    const ev = first(
      normalizeAll([
        {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          num_turns: 4,
          total_cost_usd: 0.14,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]),
    );
    expect(ev.type).toBe("run_finished");
    expect(ev.actor).toEqual({ kind: "system" });
    expect(ev.payload).toMatchObject({
      total_cost_usd: 0.14,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it("degrades an unknown SDK message to ai_raw without throwing", () => {
    const out = normalizeAll([{ type: "some_future_type", data: 1 }]);
    expect(first(out).type).toBe("ai_raw");
  });
});

describe("raw-fixtures cross-check (drift fails)", () => {
  // The raw spike capture, fed through normalize(), must produce the same ORDERED
  // type sequence as the DURABLE run-scoped events in the contract fixture
  // (sample_run.jsonl). normalize() does not emit the ephemeral ai_text_delta
  // events (those are the runner's live partial-message path), and the fixture
  // additionally leads with session-scoped events (participant_joined,
  // chat_message) that have no SDK producer — so the comparison is against the
  // fixture's durable, run-scoped subset. Any drift fails this test.
  const rawPath = fileURLToPath(new URL("./fixtures/raw_run.jsonl", import.meta.url));
  const samplePath = fileURLToPath(
    new URL("../../packages/contracts/fixtures/sample_run.jsonl", import.meta.url),
  );

  it("normalized raw types match the contract fixture's durable run-scoped types", () => {
    const raw = readFileSync(rawPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const produced = normalizeAll(raw).map((e) => e.type);

    const sample: EventEnvelope[] = readFileSync(samplePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const durableRunScoped = sample
      .filter((e) => e.ai_run_id !== null && e.id !== null)
      .map((e) => e.type);

    expect(produced).toEqual(durableRunScoped);
  });
});
