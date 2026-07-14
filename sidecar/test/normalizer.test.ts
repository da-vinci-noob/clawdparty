import { describe, expect, it } from "vitest";
import {
  AI_RAW_CAP_BYTES,
  Normalizer,
  boundRawPayload,
  redactCredentials,
} from "../src/normalizer.js";

const ctx = { sessionId: "sess_1", aiRunId: "run_1", requestedBy: "part_1" };

describe("normalizer v1 — never-crash unknown -> ai_raw", () => {
  it("degrades an unknown SDK message to ai_raw without throwing", () => {
    const n = new Normalizer(ctx);
    const event = n.toAiRaw({ type: "some_future_sdk_message", data: 42 }, 0);
    expect(event.type).toBe("ai_raw");
    expect(event.actor).toEqual({ kind: "system" });
    expect(event.session_id).toBe("sess_1");
    expect(event.id).toBeNull(); // Rails assigns the global id
  });

  it("does not throw on a malformed/circular message", () => {
    const n = new Normalizer(ctx);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => n.toAiRaw(circular, 0)).not.toThrow();
  });
});

describe("ai_raw bounding — redact FIRST, then truncate", () => {
  it("redacts credential-like keys by name (more than the obvious four)", () => {
    const redacted = redactCredentials({
      api_key: "sk-secret",
      token: "tok",
      aws_secret_access_key: "AKIA...",
      private_key: "-----BEGIN",
      pwd: "hunter2",
      nested: { authorization: "Bearer x", safe: "keep" },
      safe: "keep",
    }) as Record<string, unknown>;

    expect(redacted.api_key).toBe("[REDACTED]");
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.aws_secret_access_key).toBe("[REDACTED]");
    expect(redacted.private_key).toBe("[REDACTED]");
    expect(redacted.pwd).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).safe).toBe("keep");
    expect(redacted.safe).toBe("keep");
  });

  it("truncates an oversized payload to the 8KB cap with truncated:true", () => {
    const big = { blob: "x".repeat(AI_RAW_CAP_BYTES * 2) };
    const bounded = boundRawPayload(big);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded.raw), "utf8")).toBeLessThan(
      AI_RAW_CAP_BYTES + 256,
    );
  });

  it("redacts a credential even when the value straddles the cap boundary", () => {
    // A huge credential value that would be sliced mid-string by a naive cap.
    const payload = { filler: "a".repeat(AI_RAW_CAP_BYTES), api_key: "z".repeat(4000) };
    const bounded = boundRawPayload(payload);
    const serialized = JSON.stringify(bounded.raw);
    expect(serialized).not.toContain("zzzz"); // the credential never survives
  });
});

describe("seq + ephemeral classification", () => {
  it("assigns per-run monotonic seq to durable events only", () => {
    const n = new Normalizer(ctx);
    const a = n.toAiRaw({ x: 1 }, 0);
    const b = n.toAiRaw({ x: 2 }, 0);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("ephemeral ai_text_delta carries null seq + null id and does not advance seq", () => {
    const n = new Normalizer(ctx);
    const before = n.toAiRaw({ x: 1 }, 0); // seq 1
    const delta = n.textDelta("blk", "hi", 0);
    const after = n.toAiRaw({ x: 2 }, 0); // seq 2 — delta did NOT consume one
    expect(before.seq).toBe(1);
    expect(delta.seq).toBeNull();
    expect(delta.id).toBeNull();
    expect(after.seq).toBe(2);
  });

  it("classifies ai_text_delta/presence_changed as ephemeral", () => {
    const n = new Normalizer(ctx);
    expect(n.isEphemeral("ai_text_delta")).toBe(true);
    expect(n.isEphemeral("presence_changed")).toBe(true);
    expect(n.isEphemeral("ai_text")).toBe(false);
  });
});

describe("actor stamping", () => {
  it("stamps run_interrupted as user via requested_by", () => {
    const n = new Normalizer(ctx);
    expect(n.runInterrupted(0).actor).toEqual({ kind: "user", id: "part_1" });
  });

  it("emits ts as ISO-8601 ms+Z", () => {
    const n = new Normalizer(ctx);
    expect(n.runInterrupted(0).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
