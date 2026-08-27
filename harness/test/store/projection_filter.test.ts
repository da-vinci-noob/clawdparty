import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store/store.js";
import type { Entry, HarnessStoreApi, Transaction } from "../../src/store/types.js";

/**
 * Which entries belong in the Postgres projection.
 *
 * The store holds two kinds of entry that never reach the event stream: the per-call tool
 * results the request surface needs, and recovery's settlements. Re-deriving `events` from
 * `entriesFrom(0)` unfiltered would project them as phantom rows.
 *
 * `seq IS NULL` looks like the discriminator and is NOT one: a session-scoped `chat_message`
 * has no per-run seq either, and it is very much emitted. The first test below is that
 * collision, written so the cheap rule cannot be adopted later by someone who reasons about
 * it the way I first did.
 */

let dir: string;
let store: HarnessStoreApi;

const SESSION = "77";

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
    emitted: 1,
    ...over,
  };
}

const chatMessage = () =>
  entry({
    run_id: null,
    seq: null,
    type: "chat_message",
    actor_kind: "user",
    actor_id: "p1",
    payload: { text: "hello" },
  });

const toolResult = () =>
  entry({
    seq: null,
    type: "tool_finished",
    actor_kind: "system",
    emitted: 0,
    settlement_key: "toolu_1",
    on_surface: 1,
    blocks: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  });

function tx(...writes: Transaction["writes"]): Transaction {
  return { writes };
}

function dbPath(): string {
  return join(dir, `session-${SESSION}.sqlite3`);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-projection-"));
  const result = await openStore(SESSION, { dir });
  if (!result.ok) throw new Error(`open failed: ${result.reason}`);
  store = result.store;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a store-only entry is marked, not inferred", () => {
  it("does not identify store-only entries by a null seq", () => {
    store.commit(
      tx({ kind: "entry", entry: chatMessage() }, { kind: "entry", entry: toolResult() }),
    );

    // Both rows have `seq IS NULL`. If the projection filtered on that, every chat message
    // in the session would disappear from the re-derived feed — a silent omission, which is
    // the failure mode that survives review.
    const nullSeq = store.entriesFrom(0).filter((e) => e.seq === null);
    expect(nullSeq).toHaveLength(2);
    expect(new Set(nullSeq.map((e) => e.emitted))).toEqual(new Set([0, 1]));
  });

  it("projects the chat message and withholds the tool result", () => {
    store.commit(
      tx({ kind: "entry", entry: chatMessage() }, { kind: "entry", entry: toolResult() }),
    );

    expect(store.projectionFrom(0).map((e) => e.type)).toEqual(["chat_message"]);
  });

  it("keeps store-only entries in entriesFrom, which is the reconstruction read", () => {
    store.commit(tx({ kind: "entry", entry: toolResult() }));

    // The tool result is withheld from the PROJECTION and required by the SURFACE. A filter
    // applied in the wrong place breaks request reconstruction instead of the feed.
    expect(store.entriesFrom(0)).toHaveLength(1);
    expect(store.surfaceFrom(0)).toHaveLength(1);
  });

  it("honours the projection cursor", () => {
    store.commit(
      tx(
        { kind: "entry", entry: entry({ seq: 1 }) },
        { kind: "entry", entry: toolResult() },
        { kind: "entry", entry: entry({ seq: 2 }) },
      ),
    );

    // store_seq 2 is the withheld row; asking from 2 must not resurrect it.
    expect(store.projectionFrom(2).map((e) => e.store_seq)).toEqual([3]);
  });
});

describe("the store refuses an entry whose marking contradicts its shape", () => {
  it("rejects a store-only entry that consumed a seq", () => {
    // A withheld entry that took a seq punches a hole in the emitted sequence, and the web
    // reducer treats a gap as a dropped event.
    expect(() =>
      store.commit(tx({ kind: "entry", entry: entry({ emitted: 0, seq: 4 }) })),
    ).toThrow();
  });

  it("rejects an emitted run-scoped entry with no seq", () => {
    // The other direction: an emitted entry without a seq has no position in the run's
    // stream, so the client cannot order it. This is the bug the fixture recapture found in
    // `recovery_applied`.
    expect(() => store.commit(tx({ kind: "entry", entry: entry({ seq: null }) }))).toThrow();
  });

  it("still allows an emitted SESSION-scoped entry with no seq", () => {
    // Because `seq` is per-run, a session-scoped entry legitimately has none — this is the
    // case the two CHECKs above must not catch.
    expect(() => store.commit(tx({ kind: "entry", entry: chatMessage() }))).not.toThrow();
  });

  it("enforces the marking in the DATABASE, not just in TypeScript", () => {
    const raw = new Database(dbPath());

    // A Ruby or sqlite3 writer bypasses the TS types entirely. The rule has to hold for
    // anything that opens the file.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO entries (run_id, seq, type, actor_kind, ts_ms, payload, on_surface, emitted)
           VALUES ('run_1', 9, 'ai_text', 'claude', 1, '{}', 0, 0)`,
        )
        .run(),
    ).toThrow();
    raw.close();
  });
});

describe("the schema version moved with the column", () => {
  it("refuses a store written before `emitted` existed", async () => {
    await store.close();
    const raw = new Database(dbPath());
    raw.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    raw.close();

    // Version 2 stores have no `emitted` column, so every entry would read as emitted and
    // the projection would carry phantoms. Refusal, never migration (invariant 11).
    const reopened = await openStore(SESSION, { dir });
    expect(reopened.ok).toBe(false);
    if (reopened.ok) throw new Error("expected refusal");
    expect(reopened.reason).toBe("incompatible_version");

    const fix = new Database(dbPath());
    fix.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    fix.close();
    const ok = await openStore(SESSION, { dir });
    if (!ok.ok) throw new Error("reopen failed");
    store = ok.store;
  });
});
