import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type EventEnvelope, SYNTHESIZED_EVENT_TYPES } from "@clawdparty/contracts";
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

  it("does not echo capability fields on run_started (always-on model, no per-run selection)", () => {
    const ev = first(
      normalizeAll([
        { type: "system", subtype: "init", model: "m", cwd: "/repo", session_id: "s" },
      ]),
    );
    const payload = ev.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("disallowed_tools");
    expect(payload).not.toHaveProperty("connectors");
    expect(payload).not.toHaveProperty("skills");
  });

  it("maps assistant text → durable ai_text and thinking → ai_thinking", () => {
    const out = normalizeAll([
      {
        type: "assistant",
        uuid: "u1",
        message: {
          id: "M1",
          content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "hmm" },
          ],
        },
      },
    ]);
    expect(out.map((e) => e.type)).toEqual(["ai_text", "ai_thinking"]);
    // Keyed by the stable message.id + block type, not the per-emission uuid.
    expect(first(out).payload).toMatchObject({ block: "M1:text", text: "hello" });
    expect(out[1]?.payload).toMatchObject({ block: "M1:thinking", text: "hmm" });
  });

  it("durable ai_thinking carries the accumulated thinking_delta text when the final block is empty", () => {
    // The real SDK's finalized `thinking` block is signature-only (thinking: "");
    // the text arrives ONLY via streaming thinking_deltas. The durable ai_thinking
    // must reconstruct the full text from those deltas, else the UI block is empty.
    const out = normalizeAll([
      {
        type: "stream_event",
        uuid: "u-start",
        event: { type: "message_start", message: { id: "M1" } },
      },
      {
        type: "stream_event",
        uuid: "u-a",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me " },
        },
      },
      {
        type: "stream_event",
        uuid: "u-b",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think about it" },
        },
      },
      {
        type: "assistant",
        uuid: "u-x",
        message: { id: "M1", content: [{ type: "thinking", thinking: "" }] },
      },
    ]);
    const durable = out.find((e) => e.type === "ai_thinking");
    expect(durable?.payload).toMatchObject({ block: "M1:thinking", text: "let me think about it" });
  });

  it("durable ai_thinking prefers a non-empty block.thinking over accumulated deltas", () => {
    const out = normalizeAll([
      {
        type: "stream_event",
        uuid: "u-start",
        event: { type: "message_start", message: { id: "M9" } },
      },
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
        uuid: "u9b",
        message: { id: "M9", content: [{ type: "thinking", thinking: "full thought" }] },
      },
    ]);
    const durable = out.find((e) => e.type === "ai_thinking");
    expect(durable?.payload).toMatchObject({ block: "M9:thinking", text: "full thought" });
  });

  it("keys every delta AND durable block of one turn by message.id + block type (not per-emission uuid)", () => {
    // The real SDK gives EVERY streamed message/delta a UNIQUE top-level `uuid`
    // (raw_run.jsonl:2-4: one turn's three assistant messages share message.id but
    // have three different uuids). The stable per-turn id is `message.id`, carried
    // ONLY on the `message_start` stream_event; content_block_deltas do not carry it.
    // Within a message, blocks are distinguished by type (thinking vs text). So all
    // deltas + the durable block of one turn must share `<message.id>:<block_type>`.
    const out = normalizeAll([
      {
        type: "stream_event",
        uuid: "u-start",
        event: { type: "message_start", message: { id: "M1" } },
      },
      {
        type: "stream_event",
        uuid: "u-a",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me " },
        },
      },
      {
        type: "stream_event",
        uuid: "u-b",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think" },
        },
      },
      {
        type: "stream_event",
        uuid: "u-c",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        },
      },
      {
        type: "stream_event",
        uuid: "u-d",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "**world**" },
        },
      },
      {
        type: "assistant",
        uuid: "u-x",
        message: { id: "M1", content: [{ type: "thinking", thinking: "" }] },
      },
      {
        type: "assistant",
        uuid: "u-y",
        message: { id: "M1", content: [{ type: "text", text: "Hello **world**" }] },
      },
    ]);

    const blocksOf = (type: string) =>
      out.filter((e) => e.type === type).map((e) => (e.payload as { block: string }).block);
    // Both thinking deltas share one block; both text deltas share another — no fragmentation.
    expect(blocksOf("ai_thinking_delta")).toEqual(["M1:thinking", "M1:thinking"]);
    expect(blocksOf("ai_text_delta")).toEqual(["M1:text", "M1:text"]);

    // The durable blocks use the SAME keys, so the thinking reconstruction resolves.
    expect(out.find((e) => e.type === "ai_thinking")?.payload).toEqual({
      block: "M1:thinking",
      text: "let me think",
    });
    expect(out.find((e) => e.type === "ai_text")?.payload).toEqual({
      block: "M1:text",
      text: "Hello **world**",
    });
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
  // type sequence as the MAPPED events in the contract fixture. Three groups of
  // fixture events have no SDK producer and are excluded:
  //
  //   - ephemeral (ai_text_delta, ai_thinking_delta, context_usage) — the
  //     runner's live partial-message path, not normalize()'s output;
  //   - session-scoped (participant_joined, chat_message, plugin_*) — Rails- and
  //     harness-originated;
  //   - SYNTHESIZED_EVENT_TYPES — the harness's own decisions plus user_prompt.
  //
  // The synthesized exclusion is EXPLICIT rather than implied by "durable and
  // run-scoped". That filter alone used to be sufficient, but only because the
  // fixture happened to contain no durable run-scoped synthesized events; once
  // v1.5 added request_header and friends, the coincidence stopped holding. Any
  // real drift still fails this test.
  const rawPath = fileURLToPath(new URL("./fixtures/raw_run.jsonl", import.meta.url));
  const samplePath = fileURLToPath(
    new URL("../../packages/contracts/fixtures/sample_run.jsonl", import.meta.url),
  );
  const synthesized = new Set<string>(SYNTHESIZED_EVENT_TYPES);

  it("normalized raw types match the contract fixture's mapped run-scoped types", () => {
    const raw = readFileSync(rawPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const produced = normalizeAll(raw).map((e) => e.type);

    const sample: EventEnvelope[] = readFileSync(samplePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const mappedRunScoped = sample
      .filter((e) => e.ai_run_id !== null && e.id !== null && !synthesized.has(e.type))
      .map((e) => e.type);

    expect(produced).toEqual(mappedRunScoped);
  });

  it("the normalizer never emits a synthesized type", () => {
    // normalize() maps provider messages. If it ever produces a synthesized
    // type, the two producers have merged and the exclusion above silently
    // starts hiding real drift instead of a known absence.
    const raw = readFileSync(rawPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const leaked = normalizeAll(raw)
      .map((e) => e.type)
      .filter((t) => synthesized.has(t));

    expect(leaked, `normalizer emitted synthesized type(s): ${leaked.join(", ")}`).toEqual([]);
  });
});
