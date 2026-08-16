import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as checkpoint from "../../src/loop/checkpoint.js";
import { applyRecovery } from "../../src/store/recovery.js";
import { openStore } from "../../src/store/store.js";
import type { Entry, HarnessStoreApi } from "../../src/store/types.js";

/**
 * The crash-injection driver — gate 1.
 *
 * SIGKILL, in a CHILD PROCESS, at every commit boundary. Not a thrown error and not a
 * mocked failure: `throw` unwinds through `finally` blocks and gives the loop a chance
 * to tidy up, which is precisely the chance a real crash does not give. Anything that
 * survives a `throw` proves nothing about a power cut.
 *
 * A child is required for the same reason — SIGKILL is unmaskable, so killing the test
 * runner would end the run rather than the subject.
 *
 * The kill point is a COMMIT INDEX because `store.commit` is the only write primitive in
 * the harness, so "every commit boundary" is the complete set of states a crash can
 * observe. Killing on a timer would sample them unevenly and differently on every
 * machine.
 *
 * SIDE EFFECTS ARE OBSERVED THROUGH THE FILESYSTEM, not a counter. A counter dies with
 * the process, which is exactly when double-execution would happen; a file outlives it,
 * so "did `bash` run twice across a crash and a recovery" is answerable.
 */

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));
const SESSION = "session_crash";
export const RUN = "run_crash";

export interface CrashRun {
  dir: string;
  /** Absolute path to the side-effect ledger; one line per `never`-policy execution. */
  effectsLog: string;
  /** Commits the child completed before dying (or in total, when it ran clean). */
  commits: number;
  killedAt: number | null;
  exitSignal: string | null;
}

export interface RecoveredState {
  entries: Entry[];
  position: checkpoint.Position | null;
  effects: string[];
  uncertain: boolean;
  action: string;
  synthesized: number;
  reexecuted: number;
}

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-crash-"));
}

/**
 * Run the representative narrative in a child, killing it at commit `killAt`.
 * `killAt = null` runs it to completion, which is how the total commit count is
 * discovered before sweeping the kill points.
 */
export function runToCrash(killAt: number | null, dir = newDir()): CrashRun {
  const effectsLog = join(dir, "effects.log");
  let stdout = "";
  let exitSignal: string | null = null;

  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", CHILD], {
      env: {
        ...process.env,
        CRASH_DIR: dir,
        CRASH_EFFECTS: effectsLog,
        CRASH_KILL_AT: killAt === null ? "" : String(killAt),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { signal?: string | null; stdout?: string };
    // SIGKILL is the EXPECTED outcome of an injected crash, so it is not an error here.
    exitSignal = e.signal ?? null;
    stdout = e.stdout ?? "";
  }

  return {
    dir,
    effectsLog,
    commits: lastCommitCount(stdout),
    killedAt: killAt,
    exitSignal,
  };
}

/** The child prints `COMMITS=<n>` after each commit, so the last line is the count. */
function lastCommitCount(stdout: string): number {
  const matches = [...stdout.matchAll(/^COMMITS=(\d+)$/gm)];
  return matches.length === 0 ? 0 : Number(matches.at(-1)?.[1]);
}

/**
 * Recover the crashed run in THIS process and report what the record now says.
 *
 * Reopening is itself part of what is under test: it only works because a crash leaves
 * the session lock behind and staleness reclaims it, while a clean close releases it.
 */
export async function recover(run: CrashRun, staleAfterMs = 0): Promise<RecoveredState> {
  const opened = await openStore(SESSION, { dir: run.dir, staleAfterMs });
  if (!opened.ok) throw new Error(`could not reopen the crashed store: ${opened.reason}`);
  const store = opened.store;

  try {
    const outcome = await applyRecovery(store, RUN, {
      now: () => 1_700_000_000_000,
      // Re-execution of a `safe` call is deterministic here; a `never` call must never
      // reach this, which is what no_double_effect asserts.
      reexecute: async () => ({ ok: true, text: "re-read after recovery" }),
    });

    return {
      entries: store.entriesFrom(0),
      position: checkpoint.read(store, RUN),
      effects: readEffects(run.effectsLog),
      uncertain: outcome.uncertain,
      action: outcome.action,
      synthesized: outcome.synthesized,
      reexecuted: outcome.reexecuted,
    };
  } finally {
    await store.close();
  }
}

export function readEffects(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** Append one line per irreversible effect. Called by the child's fake `bash`. */
export function recordEffect(path: string, what: string): void {
  appendFileSync(path, `${what}\n`);
}

/** Open a crashed store without recovering, for assertions about the raw record. */
export async function inspect(
  run: CrashRun,
): Promise<{ store: HarnessStoreApi; close: () => Promise<void> }> {
  const opened = await openStore(SESSION, { dir: run.dir, staleAfterMs: 0 });
  if (!opened.ok) throw new Error(`could not open: ${opened.reason}`);
  return { store: opened.store, close: () => opened.store.close() };
}

/** Every commit boundary of a clean run — the complete set of crash points. */
export function commitBoundaries(): number[] {
  const clean = runToCrash(null);
  if (clean.commits === 0) throw new Error("the representative run performed no commits");
  return Array.from({ length: clean.commits }, (_, i) => i + 1);
}

export { SESSION };
