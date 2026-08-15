import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AI_RAW,
  type Actor,
  EPHEMERAL_EVENT_TYPES,
  EVENT_TYPES,
  type EnvelopeType,
  type EventEnvelope,
  SYNTHESIZED_EVENT_TYPES,
} from "../src/events.js";

/**
 * The executable contract: assert that `sample_run.jsonl` obeys every FROZEN
 * envelope rule (envelope fields, dual cursor, ephemeral null-id/seq, per-type
 * actor.kind). The fixture is real spike-derived output for the SDK-era types
 * plus hand-authored harness-era types (v1.5), so a smoke check confirms durable
 * payloads are non-empty; per-type payload-field validation is the harness
 * normalizer cross-check.
 *
 * This file is only a guard if it is TYPE-CHECKED — the exhaustive
 * `Record<EnvelopeType, …>` below is what catches a taxonomy addition that
 * forgot to declare its axes. `tsconfig.json` covers `fixtures/**` for exactly
 * that reason; before v1.5 it did not, which is how `user_prompt` (v1.2) and
 * `ai_thinking_delta` (v1.3) went two versions undeclared here.
 */

const EPHEMERAL = new Set<EnvelopeType>(EPHEMERAL_EVENT_TYPES);

// Session-scoped types carry a null ai_run_id. Everything else is run-scoped.
const SESSION_SCOPED = new Set<EnvelopeType>([
  "chat_message",
  "task_created",
  "task_updated",
  "participant_joined",
  "presence_changed",
  // Enabling a plugin is a property of the room, not of whatever run is open.
  "plugin_enabled",
  "plugin_disabled",
]);

// The frozen per-type actor.kind table (docs/contracts/events.md §6).
// EXHAUSTIVE over EnvelopeType by construction — adding a taxonomy name without
// a row here fails the typecheck, which is the point.
const ACTOR_KIND: Record<EnvelopeType, Actor["kind"]> = {
  run_started: "user",
  user_prompt: "user",
  ai_text_delta: "claude",
  ai_text: "claude",
  ai_thinking_delta: "claude",
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
  // Harness types (v1.5). The harness itself acts, so these are `system` —
  // except the plugin toggles, which are a human's decision about the room.
  request_header: "system",
  context_compacted: "system",
  context_usage: "system",
  tool_refused: "system",
  plugin_enabled: "user",
  plugin_disabled: "user",
  provider_error: "system",
  recovery_applied: "system",
  ai_raw: "system",
};

const KNOWN_TYPES = new Set<EnvelopeType>([...EVENT_TYPES, AI_RAW]);
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const path = fileURLToPath(new URL("./sample_run.jsonl", import.meta.url));
const events: EventEnvelope[] = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((line: string) => JSON.parse(line) as EventEnvelope);

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
        continue;
      }
      expect(Number.isInteger(e.id), `${e.type} needs integer id`).toBe(true);
      expect(e.id, "id must ascend").toBeGreaterThan(lastId);
      lastId = e.id as number;
    }
  });

  it("per-run seq is monotonic and is not advanced by ephemeral events", () => {
    const seqByRun: Record<string, number> = {};
    for (const e of events) {
      if (EPHEMERAL.has(e.type) || SESSION_SCOPED.has(e.type)) {
        expect(e.seq, `${e.type} must have null seq`).toBeNull();
        continue;
      }
      expect(e.ai_run_id, `${e.type} is run-scoped and needs an ai_run_id`).not.toBeNull();
      const runId = e.ai_run_id as string;
      const expected = (seqByRun[runId] ?? 0) + 1;
      expect(e.seq, `${e.type} seq should be ${expected}`).toBe(expected);
      seqByRun[runId] = e.seq as number;
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
      expect(e.actor.kind, `${e.type} actor.kind`).toBe(ACTOR_KIND[e.type]);
      if (e.actor.kind === "user") {
        expect(typeof e.actor.id, `${e.type} user actor needs id`).toBe("string");
      } else {
        expect("id" in e.actor, `${e.type} non-user actor must not carry id`).toBe(false);
      }
    }
  });

  // v1.1 smoke check: the fixture carries concrete payloads (no longer the v1.0
  // placeholder `{}`). Per-type field validation is the harness normalizer
  // cross-check, not this fixture test.
  it("durable events carry non-empty payloads (real fixture, not placeholder)", () => {
    for (const e of events) {
      if (EPHEMERAL.has(e.type)) continue;
      const payload = e.payload as Record<string, unknown>;
      expect(Object.keys(payload).length, `${e.type} payload should be non-empty`).toBeGreaterThan(
        0,
      );
    }
  });

  // The fixture is the EXECUTABLE contract, so a taxonomy addition that no
  // fixture line exercises is untested by every one of the four artifacts that
  // replay it. This is what makes "refresh the fixture" a checkable claim rather
  // than a habit — user_prompt (v1.2) sat unexercised here for three versions.
  it("exercises every harness-synthesized type", () => {
    const present = new Set<EnvelopeType>(events.map((e) => e.type));
    const missing = SYNTHESIZED_EVENT_TYPES.filter((t) => !present.has(t));
    expect(missing, `synthesized types absent from the fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("never carries a credential value, in any payload", () => {
    // Source IDENTITIES are expected and fine; a value never is. Guards the
    // "record the source, never the value" rule at the fixture level so a
    // careless hand-edit cannot commit one.
    const forbidden = [/sk-ant-[A-Za-z0-9-]/, /"(access|refresh)_token"\s*:/, /AKIA[0-9A-Z]{16}/];
    const raw = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      expect(pattern.test(raw), `fixture matches a credential pattern: ${pattern}`).toBe(false);
    }
  });
});
