/**
 * `npm run reconstruct -- --session <id> --out <file>` — rebuild a session's requests from
 * its record.
 *
 * The manual counterpart to gate 2: the automated test proves reconstruction on scripted
 * runs, this rebuilds a REAL session so the output can be diffed against what the provider
 * actually received.
 *
 * Opens the store READ-ONLY, so it works on a session the running harness owns. Reading a
 * live record is when reading it matters most, and requiring the harness to be stopped first
 * would make this useless for exactly that case.
 *
 * WHICH requests come out, stated plainly. A request's prefix ends where the request was built,
 * and every turn that reported usage records that boundary on its ledger row — so
 * intermediate requests are rebuildable, not just the turns whose `request_header` changed
 * (headers are emit-on-change). This emits one line per boundary from the ledger AND from the
 * headers, plus the request the session would send NEXT, and REPORTS what it could not place: a
 * turn that reported no usage at all still has no boundary. A tool that silently emitted fewer
 * lines than there were requests would read as a passing diff.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import * as request from "../src/loop/request_builder.js";
import { AnthropicDirectAdapter } from "../src/providers/anthropic_direct.js";
import { composeSystemPrompt, resolveSkills } from "../src/skills.js";
import { openStore } from "../src/store/store.js";
import type { Entry } from "../src/store/types.js";
import { DEFAULT_SYSTEM_PROMPT, buildRegistry } from "../src/supervisor.js";

interface Args {
  session: string;
  out: string;
  systemPrompt?: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      return { error: `expected --flag value pairs, got ${key ?? "(end)"}` };
    }
    out[key.slice(2)] = value;
  }
  if (!out.session) return { error: "--session is required" };
  if (!out.out) return { error: "--out is required" };
  return { session: out.session, out: out.out, systemPrompt: out["system-prompt"] };
}

/**
 * Prefix boundaries: each `request_header`'s own store_seq, plus the whole log.
 *
 * INCLUSIVE of the header, which looks wrong and is not. The header is committed with the
 * request's intent, before any of the response, so entries up to and including it are
 * exactly what the request was folded from. Excluding it — the first thing I tried — left
 * the FIRST request with no snapshot in its own prefix and it could not be rebuilt at all.
 * Including it is free: a header entry carries no blocks, so it is off the surface and
 * contributes nothing to the fold.
 */
function boundaries(entries: Entry[], ledgerBoundaries: number[]): number[] {
  const headers = entries.filter((e) => e.type === "request_header").map((e) => e.store_seq);
  const all = entries.at(-1)?.store_seq ?? 0;
  // The LEDGER's boundaries are the ones that make intermediate requests rebuildable: one
  // per turn, recorded at build time, where `request_header` only marks the turns whose snapshot
  // CHANGED. Headers are still included — they cost nothing and cover a turn that reported no
  // usage — and `all` is the request the session would send next.
  return [...new Set([...headers, ...ledgerBoundaries, all])]
    .filter((seq) => seq > 0)
    .sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(
      `${parsed.error}\nusage: npm run reconstruct -- --session <id> --out <file> [--system-prompt <text>]\n`,
    );
    process.exit(2);
  }

  const config = loadConfig();
  const opened = await openStore(parsed.session, { dir: config.storeDir, readOnly: true });
  if (!opened.ok) {
    process.stderr.write(`cannot read session ${parsed.session}: ${opened.reason}\n`);
    process.exit(1);
  }

  const entries = opened.store.entriesFrom(0);
  if (entries.length === 0) {
    process.stderr.write(`session ${parsed.session} has no entries\n`);
    await opened.store.close();
    process.exit(1);
  }

  // The two values the record fingerprints rather than copies. `reconstruct` REFUSES on a
  // digest mismatch, so a wrong system prompt is reported rather than silently folded — but
  // it has to be supplied, and the default is the one the supervisor uses.
  const adapter = new AnthropicDirectAdapter();
  const model = (entries.find((e) => e.type === "request_header")?.payload as { model?: string })
    ?.model;
  const capabilities = adapter.capabilities(model ?? "");
  const tools = buildRegistry().schemasFor(capabilities, []);

  // The system prompt is COMPOSED when a run enabled skills, so rebuild the same
  // composition from what the run recorded: `run_started` echoes the cwd and the resolved names,
  // and `resolveSkills` is a pure function of those. Without this every skill-enabled run reports a
  // digest mismatch — the check working correctly, and useless. An explicit --system-prompt still
  // wins, for a host whose skills have changed since the run.
  const started = entries.find((e) => e.type === "run_started")?.payload as
    | { cwd?: string; skills?: string[] }
    | undefined;
  const skills =
    started?.cwd && started.skills?.length ? resolveSkills(started.cwd, started.skills).index : "";
  const systemPrompt = parsed.systemPrompt ?? composeSystemPrompt(DEFAULT_SYSTEM_PROMPT, skills);

  const lines: string[] = [];
  const skipped: string[] = [];
  const verdicts: string[] = [];

  // Every run in the session, since a session's log spans runs and each one has its own ledger.
  const runIds = [
    ...new Set(entries.map((e) => e.run_id).filter((id): id is string => id !== null)),
  ];
  const ledgerBoundaries = runIds
    .flatMap((runId) => opened.store.usageRows(runId))
    .map((row) => row.entry_store_seq)
    .filter((seq): seq is number => seq !== null);

  for (const boundary of boundaries(entries, ledgerBoundaries)) {
    const result = request.reconstruct({
      entries: entries.filter((e) => e.store_seq <= boundary),
      systemPrompt,
      tools,
      capabilities,
      signal: new AbortController().signal,
    });

    if (!result.ok) {
      skipped.push(
        result.reason === "digest_mismatch"
          ? `store_seq ${boundary}: ${result.field} digest ${result.recorded} != supplied ${result.supplied}`
          : `store_seq ${boundary}: ${result.reason}`,
      );
      continue;
    }
    const { signal: _signal, ...comparable } = result.request;
    verdicts.push(result.messages.status);
    lines.push(
      JSON.stringify({
        up_to_store_seq: boundary,
        // The record's OWN answer to "is this the request that went out?" (contract 1.16). This is
        // what makes S4 step 2 performable: before it, the step said to diff against a file no
        // script writes, so there was no comparison side for a real session at all.
        messages: result.messages,
        request: comparable,
      }),
    );
  }

  mkdirSync(dirname(parsed.out), { recursive: true });
  // No trailing newline on an empty result: a file containing one blank line diffs as
  // "one empty request", which is a different claim from "nothing was rebuilt".
  writeFileSync(parsed.out, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  await opened.store.close();

  process.stdout.write(`reconstructed ${lines.length} request(s) -> ${parsed.out}\n`);

  // The verdict tally, on stdout because it is the RESULT and not a caveat. `match` is the only
  // line that says the record still rebuilds what was sent; the other three each say the check
  // could not be made, for different reasons, and none of them is a pass.
  const tally = new Map<string, number>();
  for (const v of verdicts) tally.set(v, (tally.get(v) ?? 0) + 1);
  const shown = [...tally].map(([k, n]) => `${k}=${n}`).join(" ");
  process.stdout.write(`messages digest: ${shown || "none"}\n`);
  if ((tally.get("mismatch") ?? 0) > 0) {
    process.stdout.write(
      "MISMATCH means the record no longer implies the request that was sent — that is the failure\nis about, not a tooling problem.\n",
    );
  }
  if ((tally.get("unrecorded") ?? 0) > 0) {
    process.stdout.write(
      "unrecorded = header written before contract 1.16, so nothing to compare. NOT a pass.\n",
    );
  }
  if ((tally.get("not_at_boundary") ?? 0) > 0) {
    process.stdout.write(
      "not_at_boundary = the prefix runs past the turn whose header carried the digest (the NEXT\nrequest is always one of these). Expected, and not a pass either.\n",
    );
  }
  if (skipped.length > 0) {
    // Never silent. A short file that looked complete would make an empty diff read as
    // "byte-identical" when it actually meant "nothing was compared".
    process.stderr.write(`could not rebuild ${skipped.length}:\n  ${skipped.join("\n  ")}\n`);
  }
  const headers = entries.filter((e) => e.type === "request_header").length;
  process.stderr.write(
    `note: ${headers} request_header(s) and ${ledgerBoundaries.length} ledger boundary/ies in the
record. Every turn that reported usage records where its prefix ended, so an
unchanged-snapshot turn is rebuildable too — a turn that reported NO usage still has no boundary
and is not rebuilt here.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`reconstruct failed: ${String(err)}\n`);
  process.exit(1);
});
