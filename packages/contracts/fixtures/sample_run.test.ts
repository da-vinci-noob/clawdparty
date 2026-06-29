import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AI_RAW, type Actor, EVENT_TYPES, type EnvelopeType } from "../src/events.js";

/**
 * The executable contract: assert that `sample_run.jsonl` obeys every FROZEN
 * envelope rule (envelope fields, dual cursor, ephemeral null-id/seq, per-type
 * actor.kind). As of v1.1 the fixture is REAL spike-derived output with concrete
 * payloads, so a smoke check confirms durable payloads are non-empty; per-type
 * payload-field validation is the sidecar-runner normalizer cross-check.
 */

const EPHEMERAL = new Set<EnvelopeType>(["ai_text_delta", "presence_changed"]);
const SESSION_SCOPED = new Set<EnvelopeType>([
  "chat_message",
  "task_created",
  "task_updated",
  "participant_joined",
  "presence_changed",
]);

// The frozen per-type actor.kind table (docs/contracts/events.md §6).
const ACTOR_KIND: Record<EnvelopeType, Actor["kind"]> = {
  run_started: "user",
  ai_text_delta: "claude",
  ai_text: "claude",
  ai_thinking: "claude",
  tool_started: "claude",
  tool_finished: "claude",
  tool_failed: "claude",
  terminal_output: "claude",
  file_changed: "claude",
  run_finished: "system",
  run_failed: "system",
  run_interrupted: "user",
  changeset_ready: "system",
  changeset_approved: "user",
  changeset_rejected: "user",
  chat_message: "user",
  task_created: "user",
  task_updated: "user",
  participant_joined: "user",
  presence_changed: "user",
  ai_raw: "system",
};

const KNOWN_TYPES = new Set<EnvelopeType>([...EVENT_TYPES, AI_RAW]);
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const path = fileURLToPath(new URL("./sample_run.jsonl", import.meta.url));
const events = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

describe("sample_run.jsonl — frozen envelope rules", () => {
  it("has at least one event", () => {
    expect(events.length).toBeGreaterThan(0);
  });

  it("every event carries all eight envelope fields and a known type", () => {
    for (const e of events) {
      for (const field of [
        "id",
        "session_id",
        "ai_run_id",
        "seq",
        "type",
        "actor",
        "ts",
        "payload",
      ]) {
        expect(e, `missing ${field}`).toHaveProperty(field);
      }
      expect(KNOWN_TYPES.has(e.type), `unknown type ${e.type}`).toBe(true);
      expect(typeof e.session_id).toBe("string");
      expect(ISO_MS_Z.test(e.ts), `ts not ISO ms+Z: ${e.ts}`).toBe(true);
    }
  });

  it("durable ids ascend; ephemeral events carry a null id", () => {
    let lastId = 0;
    for (const e of events) {
      if (EPHEMERAL.has(e.type)) {
        expect(e.id, `${e.type} must have null id`).toBeNull();
      } else {
        expect(Number.isInteger(e.id), `${e.type} needs integer id`).toBe(true);
        expect(e.id, "id must ascend").toBeGreaterThan(lastId);
        lastId = e.id;
      }
    }
  });

  it("per-run seq is monotonic and is not advanced by ephemeral events", () => {
    const seqByRun: Record<string, number> = {};
    for (const e of events) {
      if (EPHEMERAL.has(e.type) || SESSION_SCOPED.has(e.type)) {
        expect(e.seq, `${e.type} must have null seq`).toBeNull();
        continue;
      }
      const expected = (seqByRun[e.ai_run_id] ?? 0) + 1;
      expect(e.seq, `${e.type} seq should be ${expected}`).toBe(expected);
      seqByRun[e.ai_run_id] = e.seq;
    }
  });

  it("scope: session-scoped events have null ai_run_id, run-scoped have a string", () => {
    for (const e of events) {
      if (SESSION_SCOPED.has(e.type)) {
        expect(e.ai_run_id, `${e.type} must have null ai_run_id`).toBeNull();
      } else {
        expect(typeof e.ai_run_id, `${e.type} needs string ai_run_id`).toBe("string");
      }
    }
  });

  it("actor.kind matches the frozen per-type table; id present iff user", () => {
    for (const e of events) {
      expect(e.actor.kind, `${e.type} actor.kind`).toBe(ACTOR_KIND[e.type as EnvelopeType]);
      if (e.actor.kind === "user") {
        expect(typeof e.actor.id, `${e.type} user actor needs id`).toBe("string");
      } else {
        expect("id" in e.actor, `${e.type} non-user actor must not carry id`).toBe(false);
      }
    }
  });

  // v1.1 smoke check: the real spike-derived fixture carries concrete payloads
  // (no longer the v1.0 placeholder `{}`). Per-type field validation is the
  // sidecar-runner normalizer cross-check, not this fixture test.
  it("durable events carry non-empty payloads (real spike fixture, not placeholder)", () => {
    for (const e of events) {
      if (EPHEMERAL.has(e.type)) continue;
      expect(
        Object.keys(e.payload).length,
        `${e.type} payload should be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});
