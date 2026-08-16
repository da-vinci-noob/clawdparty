#!/usr/bin/env node
// Recapture packages/contracts/fixtures/sample_run.jsonl from a REAL harness run.
//
//   node scripts/capture_fixture.ts            # print to stdout
//   node scripts/capture_fixture.ts --write    # overwrite the fixture
//
// WHY THIS EXISTS. The fixture was captured from an Agent SDK spike, and that SDK is gone
// — so it had drifted into describing a predecessor system: `run_started` still carried
// `permission_mode`/`claude_session_id`, `recovery_applied.from_phase` said
// `awaiting_provider_response` where the harness emits `request_pending`, and
// `file_changed` preceded `tool_failed` because it was derived from the tool CALL. A
// hand-edited fixture would drift again; a generated one drifts only when behaviour does.
//
// WHAT IS CAPTURED vs PRESERVED. The loop's narrative is captured by running it. Four types
// have no emitter yet — `context_compacted` and `context_usage`, `provider_error`,
// `plugin_enabled`/`plugin_disabled` — and the web tests plus the Rails
// fake-Claude replay depend on them being present. Those entries are PRESERVED verbatim
// from the previous fixture and re-sequenced onto the end. Deleting them to make the file
// "purely captured" would silently drop coverage for types the taxonomy already froze.
//
// THE CIRCULARITY IS REAL AND ACCEPTED. A generated fixture means the parity test compares
// the harness against its own output, which proves nothing on its own. That is why
// behaviour_parity.test.ts also asserts PROPERTIES the fixture cannot vouch for — every
// tool_use answered, ephemeral events carrying null seq/id, gapless durable seq. Regenerate
// deliberately, read the diff, and name the behaviour change in the CHANGELOG.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EPHEMERAL_EVENT_TYPES } from "@clawdparty/contracts";
import * as checkpoint from "../src/loop/checkpoint.ts";
import { RunLoop } from "../src/loop/run_loop.ts";
import { applyRecovery } from "../src/store/recovery.ts";
import { openStore } from "../src/store/store.ts";
import { buildRegistry } from "../src/supervisor.ts";
import { ScriptedAdapter, TURNS } from "./narrative.js";

const EPHEMERAL = new Set<string>(EPHEMERAL_EVENT_TYPES);

const FIXTURE = fileURLToPath(
  new URL("../../packages/contracts/fixtures/sample_run.jsonl", import.meta.url),
);
/**
 * Events the harness cannot emit yet, kept in their OWN committed file rather than read
 * back out of the fixture.
 *
 * Reading them from the fixture made regeneration destructive: the first `--write` dropped
 * whatever was not captured, and the second had nothing left to preserve. I lost
 * `chat_message` and `participant_joined` that way. A separate source makes the operation
 * idempotent and makes the not-yet-emittable set an explicit, reviewable list instead of a
 * residue.
 */
const NOT_YET = fileURLToPath(
  new URL("../../packages/contracts/fixtures/not_yet_emitted.jsonl", import.meta.url),
);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const opened = await openStore("45", { dir, staleAfterMs: 0 });
  if (!opened.ok) throw new Error(`store: ${opened.reason}`);

  const emitted = [];
  let clock = 0;
  let turn = 0;
  const loop = new RunLoop({
    store: opened.store,
    adapter: new ScriptedAdapter(),
    // The REAL tool set, so text_editor actually writes and bash actually runs — that
    // is what makes `file_changed` and `terminal_output` captured rather than invented.
    tools: buildRegistry(),
    emit: (events) => emitted.push(...events),
    // Fixed clock and ids: a fixture that changes on every run is a fixture nobody can
    // diff, and the diff is the entire point of regenerating it deliberately.
    now: () => 1_760_000_000_000 + clock++ * 137,
    newId: () => `turn-${++turn}`,
  });

  await loop.run({
    runId: "run_demo",
    sessionId: "45",
    lane: "main",
    prompt: "Create a note file, then read it back.",
    requestedBy: "7",
    model: "claude-opus-5",
    cwd: dir,
    systemPrompt: "You are clawdparty.",
    signal: new AbortController().signal,
  });
  // A REAL recovery, captured rather than preserved: this is what fixes the old fixture's
  // `from_phase: "awaiting_provider_response"`, a phase name the harness never emits.
  // The SAME run id as the loop's run. The fixture is replayed by Rails as one session with
  // one run (FakeClaude::Replay), so a second run_id cannot be resolved to a DB row and the
  // event is rejected on ingest — which is exactly what happened when this said
  // "run_recovered". Overwriting the terminal position is artificial, but the recovery it
  // produces is real, and it is the only way to capture the UNCERTAIN case.
  checkpoint.write(opened.store, "run_demo", {
    phase: "request_pending",
    settlementKey: "run_demo:recovery-capture:0",
    reservedUsageId: 1,
    requestSnapshotId: "snapshot",
    attempt: 0,
    maxAttempts: 3,
    notBeforeMs: 0,
  });
  const recovery = await applyRecovery(opened.store, "run_demo", {
    now: () => 1_760_000_099_000,
  });
  emitted.push(...recovery.events.map((e) => ({ ...e, session_id: "45" })));

  await opened.store.close();
  rmSync(dir, { recursive: true, force: true });

  // Re-sequenced after the captured run. Sourced from its own file, never from the fixture
  // being overwritten.
  const preserved = readFileSync(NOT_YET, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  let id = 0;
  let seq = Math.max(0, ...emitted.filter((e) => e.seq !== null).map((e) => e.seq));
  const out = [
    ...emitted,
    ...preserved.map((e) => ({ ...e, seq: e.seq === null ? null : ++seq })),
    // Ids are assigned HERE because the harness does not have them: it emits `id: null` and
    // Rails assigns the global cursor at ingest. The fixture is the stream AS CLIENTS SEE IT
    // — web tests and the Rails replay both read it — so a durable event must carry one, and
    // an ephemeral event must not. Leaving them all null made the parity baseline empty,
    // which passed as "no types to compare" rather than failing.
    // DURABILITY decides the id, not `seq`. A session-scoped durable event
    // (`participant_joined`, `chat_message`) has a NULL seq and still needs an id — it is
    // persisted, it is just not run-scoped. Keying off `seq` gave those a null id and broke
    // the frozen envelope rule that every durable event carries one.
  ].map((e) => ({ ...e, id: EPHEMERAL.has(e.type) ? null : ++id }));

  // The scratch directory is the ONLY thing that varies between runs, and it varies in
  // `run_started.cwd`. Normalized to a stable path so regenerating twice produces identical
  // bytes — a fixture nobody can diff cannot be reviewed, which is the whole reason the
  // clock and ids are fixed too.
  const jsonl = `${out
    .map((e) => JSON.stringify(e).replaceAll(dir, "/repo/session-45"))
    .join("\n")}\n`;
  if (process.argv.includes("--write")) {
    writeFileSync(FIXTURE, jsonl);
    process.stderr.write(
      `wrote ${out.length} events (${emitted.length} captured, ${preserved.length} preserved)\n`,
    );
  } else {
    process.stdout.write(jsonl);
  }
}

main().catch((err) => {
  process.stderr.write(`capture failed: ${String(err)}\n`);
  process.exit(1);
});
