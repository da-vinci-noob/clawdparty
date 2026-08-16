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
 * WHICH requests come out, stated plainly because it is a real limitation and not a rounding
 * error: a request's prefix ends where the request was built, and the record only marks that
 * for a turn that emitted a `request_header` — headers are emit-on-change, so an unchanged
 * turn has no marker. So this emits one line per header boundary, plus the request the
 * session would send NEXT, and REPORTS how many turns it could not place. A tool that
 * silently emitted fewer lines than there were requests would read as a passing diff.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import * as request from "../src/loop/request_builder.js";
import { AnthropicDirectAdapter } from "../src/providers/anthropic_direct.js";
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
function boundaries(entries: Entry[]): number[] {
  const headers = entries.filter((e) => e.type === "request_header").map((e) => e.store_seq);
  const all = entries.at(-1)?.store_seq ?? 0;
  return [...new Set([...headers, all])].sort((a, b) => a - b);
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
  const systemPrompt = parsed.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const lines: string[] = [];
  const skipped: string[] = [];

  for (const boundary of boundaries(entries)) {
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
    lines.push(JSON.stringify({ up_to_store_seq: boundary, request: comparable }));
  }

  mkdirSync(dirname(parsed.out), { recursive: true });
  // No trailing newline on an empty result: a file containing one blank line diffs as
  // "one empty request", which is a different claim from "nothing was rebuilt".
  writeFileSync(parsed.out, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  await opened.store.close();

  process.stdout.write(`reconstructed ${lines.length} request(s) -> ${parsed.out}\n`);
  if (skipped.length > 0) {
    // Never silent. A short file that looked complete would make an empty diff read as
    // "byte-identical" when it actually meant "nothing was compared".
    process.stderr.write(`could not rebuild ${skipped.length}:\n  ${skipped.join("\n  ")}\n`);
  }
  const turns = entries.filter((e) => e.type === "request_header").length;
  process.stderr.write(
    `note: ${turns} request_header(s) in the record. Turns whose snapshot was UNCHANGED emit no
header, so their prefix boundary is unmarked and they are not rebuilt here.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`reconstruct failed: ${String(err)}\n`);
  process.exit(1);
});
