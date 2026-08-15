import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterCursorToFrom, openStore } from "../../src/store/store.js";
import {
  type Entry,
  type HarnessStoreApi,
  type Position,
  STORE_SCHEMA_VERSION,
  type Transaction,
} from "../../src/store/types.js";

/**
 * The eleven invariants in the store contract are binding. Each
 * one maps to a describe block here — a numbered invariant with no test is an
 * invariant that will be broken silently.
 */

let dir: string;
let store: HarnessStoreApi;

const SESSION = "45";

function entry(over: Partial<Omit<Entry, "store_seq">> = {}): Omit<Entry, "store_seq"> {
  return {
    run_id: "run_1",
    seq: 1,
    type: "ai_text",
    actor_kind: "claude",
    actor_id: null,
    ts_ms: 1_700_000_000_000,
    payload: { block: "b:0", text: "hi" },
    blocks: null,
    on_surface: 0,
    ...over,
  };
}

function tx(...writes: Transaction["writes"]): Transaction {
  return { writes };
}

async function open(opts: { owner?: string; staleAfterMs?: number } = {}) {
  return openStore(SESSION, { dir, ...opts });
}

function dbPath(): string {
  return join(dir, `session-${SESSION}.sqlite3`);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-store-"));
  const result = await open({ owner: "test-owner" });
  if (!result.ok) throw new Error(`open failed: ${result.reason}`);
  store = result.store;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("invariant 1 — atomic commit", () => {
  it("leaves no partial state when a later write in the transaction fails", () => {
    // The second entry violates the actor_id-iff-user CHECK, so the whole
    // transaction must roll back — including the first, valid entry.
    expect(() =>
      store.commit(
        tx(
          { kind: "entry", entry: entry({ seq: 1 }) },
          { kind: "entry", entry: entry({ seq: 2, actor_kind: "claude", actor_id: "part_1" }) },
        ),
      ),
    ).toThrow();

    expect(store.entriesFrom(0)).toEqual([]);
  });

  it("rolls back register writes alongside entry writes", () => {
    expect(() =>
      store.commit(
        tx(
          {
            kind: "register",
            op: "set",
            namespace: "run.position",
            key: "run_1",
            value: { phase: "checkpoint" },
          },
          { kind: "entry", entry: entry({ actor_kind: "system", actor_id: "nope" }) },
        ),
      ),
    ).toThrow();

    expect(store.readPosition("run_1")).toBeNull();
  });
});

describe("invariant 2 — entries is insert-only", () => {
  it("refuses an UPDATE at the database level, not by convention", () => {
    store.commit(tx({ kind: "entry", entry: entry() }));
    const raw = new Database(dbPath());

    expect(() => raw.prepare("UPDATE entries SET type = 'ai_raw'").run()).toThrow(/insert-only/);
    raw.close();
  });

  it("refuses a DELETE", () => {
    store.commit(tx({ kind: "entry", entry: entry() }));
    const raw = new Database(dbPath());

    expect(() => raw.prepare("DELETE FROM entries").run()).toThrow(/insert-only/);
    raw.close();
  });

  it("refuses an UPDATE to the usage ledger too", () => {
    store.commit(tx({ kind: "usage", row: usageRow() }));
    const raw = new Database(dbPath());

    expect(() => raw.prepare("UPDATE usage SET input_tokens = 0").run()).toThrow(/append-only/);
    raw.close();
  });
});

describe("invariant 3 — store_seq is session-wide monotonic", () => {
  it("assigns ascending store_seq in write order across runs", () => {
    const result = store.commit(
      tx(
        { kind: "entry", entry: entry({ run_id: "run_1", seq: 1 }) },
        { kind: "entry", entry: entry({ run_id: "run_2", seq: 1 }) },
        {
          kind: "entry",
          entry: entry({
            run_id: null,
            seq: null,
            type: "chat_message",
            actor_kind: "user",
            actor_id: "p1",
          }),
        },
      ),
    );

    expect(result.storeSeqs).toEqual([1, 2, 3]);
    expect(result.firstStoreSeq).toBe(1);
  });

  it("keeps ascending across separate commits", () => {
    store.commit(tx({ kind: "entry", entry: entry({ seq: 1 }) }));
    const second = store.commit(tx({ kind: "entry", entry: entry({ seq: 2 }) }));

    expect(second.storeSeqs).toEqual([2]);
    expect(store.entriesFrom(0).map((e) => e.store_seq)).toEqual([1, 2]);
  });
});

describe("invariant 4 — (run_id, seq) is unique, duplicates silently skipped", () => {
  it("skips a duplicate without raising", () => {
    store.commit(tx({ kind: "entry", entry: entry({ seq: 7 }) }));
    const again = store.commit(tx({ kind: "entry", entry: entry({ seq: 7 }) }));

    expect(again.skipped).toEqual([0]);
    expect(again.storeSeqs).toEqual([null]);
    expect(store.entriesFrom(0)).toHaveLength(1);
  });

  it("does not treat two session-scoped entries as duplicates", () => {
    // Both carry (null, null). SQLite, like Postgres, treats NULLs as distinct
    // in a UNIQUE constraint — so session-scoped events never collide.
    const result = store.commit(
      tx(
        {
          kind: "entry",
          entry: entry({
            run_id: null,
            seq: null,
            type: "chat_message",
            actor_kind: "user",
            actor_id: "p1",
          }),
        },
        {
          kind: "entry",
          entry: entry({
            run_id: null,
            seq: null,
            type: "chat_message",
            actor_kind: "user",
            actor_id: "p2",
          }),
        },
      ),
    );

    expect(result.skipped).toEqual([]);
    expect(store.entriesFrom(0)).toHaveLength(2);
  });
});

describe("invariant 5 — writes within a transaction apply in order", () => {
  it("lets a register reference an entry created earlier in the same transaction", () => {
    // This is what makes the effect sandwich two commits rather than four.
    const result = store.commit(
      tx(
        { kind: "entry", entry: entry({ seq: 1 }) },
        {
          kind: "register",
          op: "set",
          namespace: "lane.leaf",
          key: "main",
          value: { storeSeq: 1 },
        },
      ),
    );

    expect(result.storeSeqs[0]).toBe(1);
    expect(store.readRegister("lane.leaf", "main")).toEqual({ storeSeq: 1 });
  });

  it("applies set-then-delete of the same register in order", () => {
    store.commit(
      tx(
        {
          kind: "register",
          op: "set",
          namespace: "run.position",
          key: "run_1",
          value: { phase: "checkpoint" },
        },
        { kind: "register", op: "del", namespace: "run.position", key: "run_1" },
      ),
    );

    expect(store.readPosition("run_1")).toBeNull();
  });
});

describe("invariant 6 — the position marker is total", () => {
  it("determines what a run owes from one read, with no log access", () => {
    const pending: Position = {
      phase: "request_pending",
      reservedEntrySeq: 4,
      reservedUsageId: 1,
      requestSnapshotId: "snap_1",
      attempt: 1,
      maxAttempts: 3,
      notBeforeMs: 0,
    };
    store.commit(
      tx({ kind: "register", op: "set", namespace: "run.position", key: "run_1", value: pending }),
    );

    expect(store.readPosition("run_1")).toEqual(pending);
  });

  it("is overwritten totally, never merged with the previous value", () => {
    store.commit(
      tx({
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: { phase: "tools", stepId: "s1", calls: [] },
      }),
    );
    store.commit(
      tx({
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: { phase: "checkpoint" },
      }),
    );

    // No residue of `stepId`/`calls` — a partial overwrite would make recovery
    // read a phase whose fields belong to an earlier step.
    expect(store.readPosition("run_1")).toEqual({ phase: "checkpoint" });
  });
});

describe("invariant 7 — a reserved id is used at most once", () => {
  it("rejects a second write under a reserved entry seq", () => {
    const reserved = store.nextSeq("run_1");
    store.commit(tx({ kind: "entry", entry: entry({ seq: reserved, type: "ai_text" }) }));

    // A synthetic settlement racing a real one must not double-write.
    const second = store.commit(
      tx({ kind: "entry", entry: entry({ seq: reserved, type: "run_interrupted" }) }),
    );

    expect(second.skipped).toEqual([0]);
    expect(store.entriesFrom(0)).toHaveLength(1);
    expect(store.entriesFrom(0)[0]?.type).toBe("ai_text");
  });

  it("rejects a second usage row under a reserved usage id", () => {
    const reserved = store.reserveUsageId();
    store.commit(tx({ kind: "usage", row: { ...usageRow(), id: reserved } }));
    store.commit(tx({ kind: "usage", row: { ...usageRow(), id: reserved, input_tokens: 999 } }));

    const raw = new Database(dbPath());
    const rows = raw.prepare("SELECT input_tokens FROM usage").all() as Array<{
      input_tokens: number;
    }>;
    raw.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.input_tokens).toBe(10);
  });
});

describe("invariant 8 — terminal cleanup", () => {
  it("deletes run.* registers and writes run.result in one transaction", () => {
    store.commit(
      tx(
        {
          kind: "register",
          op: "set",
          namespace: "run.position",
          key: "run_1",
          value: { phase: "checkpoint" },
        },
        {
          kind: "register",
          op: "set",
          namespace: "run.meta",
          key: "run_1",
          value: { prompt: "x" },
        },
        {
          kind: "register",
          op: "set",
          namespace: "lane.leaf",
          key: "main",
          value: { storeSeq: 0 },
        },
      ),
    );

    store.commit(
      tx(
        { kind: "register", op: "del", namespace: "run.position", key: "run_1" },
        { kind: "register", op: "del", namespace: "run.meta", key: "run_1" },
        {
          kind: "register",
          op: "set",
          namespace: "run.result",
          key: "run_1",
          value: { outcome: "finished", uncertain: false, stopReason: "end_turn", endedAtMs: 1 },
        },
      ),
    );

    expect(store.readPosition("run_1")).toBeNull();
    expect(store.readRegister("run.meta", "run_1")).toBeNull();
    expect(store.readRegister("run.result", "run_1")).toMatchObject({ outcome: "finished" });
    // lane.* and session.* survive a finished run.
    expect(store.readRegister("lane.leaf", "main")).toEqual({ storeSeq: 0 });
  });

  it("stops reporting a terminal run as active", () => {
    store.commit(
      tx({
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: { phase: "checkpoint" },
      }),
    );
    expect(store.activeRunIds()).toEqual(["run_1"]);

    store.commit(
      tx({
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: { phase: "terminal", outcome: "finished" },
      }),
    );
    expect(store.activeRunIds()).toEqual([]);
  });
});

describe("invariant 9 — recovery is O(1) in session length", () => {
  it("reads a position without touching entries", () => {
    store.commit(
      tx({
        kind: "register",
        op: "set",
        namespace: "run.position",
        key: "run_1",
        value: { phase: "checkpoint" },
      }),
    );

    const raw = new Database(dbPath());
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT value FROM registers WHERE namespace = 'run.position' AND key = 'run_1'`,
      )
      .all() as Array<{ detail: string }>;
    raw.close();

    const detail = plan.map((p) => p.detail).join(" ");
    expect(detail).not.toMatch(/SCAN/);
    expect(detail).toMatch(/registers/);
  });
});

describe("invariant 10 — no credential value is ever stored", () => {
  it("keeps a credential SOURCE in the record and no value anywhere", () => {
    store.commit(
      tx(
        {
          kind: "entry",
          entry: entry({
            seq: 1,
            type: "request_header",
            actor_kind: "system",
            payload: {
              provider: "anthropic-direct",
              credential_source: "file:~/.claude/.credentials.json",
              model: "claude-opus-5",
            },
          }),
        },
        {
          kind: "register",
          op: "set",
          namespace: "run.meta",
          key: "run_1",
          value: { provider: "anthropic-direct", model: "claude-opus-5" },
        },
      ),
    );

    // Scan the raw bytes, not the API — a value leaking via an unexpected column
    // would still be on disk. Under WAL the newest pages live in the
    // -wal file, so scanning only the main DB would miss everything just
    // written; and utf8 decoding mangles bytes, so latin1 is used to keep the
    // file byte-for-byte searchable.
    const raw = readFileSync(dbPath(), "latin1") + readFileSync(`${dbPath()}-wal`, "latin1");
    for (const pattern of [/sk-ant-[A-Za-z0-9]/, /"access_token"/, /AKIA[0-9A-Z]{16}/]) {
      expect(pattern.test(raw), `store matched ${pattern}`).toBe(false);
    }
    expect(raw).toContain("credential_source");
  });
});

describe("invariant 11 — version refusal, not migration", () => {
  it("refuses an unexpected schema_version and reports both numbers", async () => {
    await store.close();
    const raw = new Database(dbPath());
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("99");
    raw.close();

    const result = await open({ owner: "test-owner" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toBe("incompatible_version");
    if (result.reason !== "incompatible_version") throw new Error("wrong reason");
    expect(result).toMatchObject({ found: 99, expected: STORE_SCHEMA_VERSION });

    // Reopen at the right version so afterEach can close cleanly.
    const fix = new Database(dbPath());
    fix
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(STORE_SCHEMA_VERSION));
    fix.close();
    const reopened = await open({ owner: "test-owner" });
    if (!reopened.ok) throw new Error("reopen failed");
    store = reopened.store;
  });
});

describe("one writer per session (session.lock)", () => {
  it("refuses a second opener while the incumbent is live", async () => {
    const second = await open({ owner: "other-owner" });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected refusal");
    expect(second.reason).toBe("locked");
  });

  it("lets the same owner reopen its own store", async () => {
    const same = await open({ owner: "test-owner" });

    expect(same.ok).toBe(true);
    if (same.ok) await same.store.close();
  });

  it("reclaims a lock whose heartbeat is older than the staleness threshold", async () => {
    // A crashed harness cannot release its own lock, so reclaim is time-based.
    const second = await open({ owner: "other-owner", staleAfterMs: 0 });

    expect(second.ok).toBe(true);
    if (second.ok) await second.store.close();
  });

  it("refreshes the heartbeat so a live writer is not reclaimed", () => {
    const before = store.readRegister("session.lock", "session");
    store.heartbeat();
    const after = store.readRegister("session.lock", "session");

    expect(after?.owner).toBe("test-owner");
    expect(after?.heartbeatMs).toBeGreaterThanOrEqual(before?.heartbeatMs ?? 0);
  });
});

describe("surface and projection reads", () => {
  it("surfaceFrom returns only on-surface entries, in order", () => {
    store.commit(
      tx(
        {
          kind: "entry",
          entry: entry({ seq: 1, on_surface: 1, blocks: [{ type: "text", text: "a" }] }),
        },
        { kind: "entry", entry: entry({ seq: 2, on_surface: 0 }) },
        {
          kind: "entry",
          entry: entry({ seq: 3, on_surface: 1, blocks: [{ type: "text", text: "b" }] }),
        },
      ),
    );

    expect(store.surfaceFrom(0).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("requires blocks on an on-surface entry", () => {
    // Validation rule 4: flattening to text loses compaction state, so an
    // on-surface entry without verbatim blocks is refused outright.
    expect(() =>
      store.commit(tx({ kind: "entry", entry: entry({ on_surface: 1, blocks: null }) })),
    ).toThrow();
  });

  it("entriesFrom is INCLUSIVE and the after-cursor conversion lives in one place", () => {
    store.commit(
      tx(
        { kind: "entry", entry: entry({ seq: 1 }) },
        { kind: "entry", entry: entry({ seq: 2 }) },
        { kind: "entry", entry: entry({ seq: 3 }) },
      ),
    );

    expect(store.entriesFrom(0).map((e) => e.store_seq)).toEqual([1, 2, 3]);
    expect(store.entriesFrom(2).map((e) => e.store_seq)).toEqual([2, 3]);
    // ?after=2 must yield 3 only. Inclusive-vs-exclusive confusion here silently
    // drops or duplicates exactly one event per request.
    expect(store.entriesFrom(afterCursorToFrom(2)).map((e) => e.store_seq)).toEqual([3]);
  });

  it("round-trips payload and verbatim blocks unchanged", () => {
    const blocks = [{ type: "thinking", thinking: "…", signature: "sig" }];
    store.commit(tx({ kind: "entry", entry: entry({ on_surface: 1, blocks }) }));

    expect(store.entriesFrom(0)[0]?.blocks).toEqual(blocks);
  });
});

function usageRow() {
  return {
    run_id: "run_1",
    entry_store_seq: null,
    provider: "anthropic-direct",
    model: "claude-opus-5",
    input_tokens: 10,
    output_tokens: 20,
    cache_read: 0,
    cache_creation: 0,
    ts_ms: 1_700_000_000_000,
  };
}
