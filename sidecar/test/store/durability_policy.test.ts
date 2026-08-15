import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store/store.js";
import type { HarnessStoreApi } from "../../src/store/types.js";

/**
 * Pins the durability tradeoff so it cannot drift into an unexamined default.
 *
 * `synchronous = NORMAL`, not FULL — recorded in **plan.md → Complexity Tracking
 * row 1**. NORMAL keeps the per-step commit off the fsync path, at the cost that
 * an OS-level crash or power loss can lose the last transactions. A harness
 * process crash — which is what the recovery design is actually built for — is
 * still fully safe under WAL, because the WAL file is already written.
 *
 * This test exists because the choice is invisible at runtime: nothing fails if
 * someone "fixes" it to FULL, or if a refactor drops the pragma and SQLite's own
 * default (FULL) silently takes over. Either change should have to argue with
 * this file and the Complexity Tracking row it names.
 */

const PRAGMA_SYNCHRONOUS_NORMAL = 1; // 0=OFF 1=NORMAL 2=FULL 3=EXTRA

let dir: string;
let store: HarnessStoreApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harness-durability-"));
  const result = await openStore("45", { dir, owner: "test" });
  if (!result.ok) throw new Error(`open failed: ${result.reason}`);
  store = result.store;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durability policy (plan.md Complexity Tracking row 1)", () => {
  it("runs in WAL mode, which persists in the file", () => {
    expect(store.durability().journalMode).toBe("wal");
  });

  it("keeps synchronous at NORMAL rather than FULL, on a freshly created store", () => {
    // The fresh-creation case is the one that needs the explicit pragma: a newly
    // created file inherits FULL (asserted below), so without it a session's
    // FIRST run would commit under different durability than every later one.
    expect(store.durability().synchronous).toBe(PRAGMA_SYNCHRONOUS_NORMAL);
    expect(store.durability().foreignKeys).toBe(1);
  });

  it("does not merely inherit the value — a bare connection reports something else", () => {
    // Guards against a vacuous assertion. `synchronous` defaults are BUILD- and
    // MODE-dependent (SQLITE_DEFAULT_SYNCHRONOUS vs SQLITE_DEFAULT_WAL_SYNCHRONOUS):
    // measured on 3.53.4, a newly created file reports FULL while a reopened WAL
    // file reports NORMAL. Same build, two answers — so inheriting is unsafe
    // regardless of which value a given build happens to pick.
    const fresh = new Database(join(dir, "unrelated.sqlite3"));
    const freshDefault = Number(fresh.pragma("synchronous", { simple: true }));
    fresh.close();

    expect(
      freshDefault,
      "a newly created database no longer inherits FULL on this build; " +
        "re-verify the pragma rationale in store.ts before relaxing it",
    ).not.toBe(PRAGMA_SYNCHRONOUS_NORMAL);
  });

  it("re-applies the per-connection pragmas on reopen, not just at creation", async () => {
    await store.close();

    const result = await openStore("45", { dir, owner: "test" });
    if (!result.ok) throw new Error(`reopen failed: ${result.reason}`);
    store = result.store;

    expect(store.durability()).toMatchObject({
      journalMode: "wal",
      synchronous: PRAGMA_SYNCHRONOUS_NORMAL,
      foreignKeys: 1,
    });
  });

  it("survives a process-level crash: committed entries are readable after reopen", async () => {
    // NORMAL's cost is OS-crash durability, not process-crash durability. The
    // recovery design depends on the latter, so it is asserted here directly.
    store.commit({
      writes: [
        {
          kind: "entry",
          entry: {
            run_id: "run_1",
            seq: 1,
            type: "ai_text",
            actor_kind: "claude",
            actor_id: null,
            ts_ms: 1,
            payload: { text: "before the crash" },
            blocks: null,
            on_surface: 0,
          },
        },
        {
          kind: "register",
          op: "set",
          namespace: "run.position",
          key: "run_1",
          value: { phase: "checkpoint" },
        },
      ],
    });

    // Drop the handle without a clean shutdown path, as a SIGKILL would.
    await store.close();
    const result = await openStore("45", { dir, owner: "test" });
    if (!result.ok) throw new Error(`reopen failed: ${result.reason}`);
    store = result.store;

    expect(store.entriesFrom(0)).toHaveLength(1);
    expect(store.readPosition("run_1")).toEqual({ phase: "checkpoint" });
  });
});
