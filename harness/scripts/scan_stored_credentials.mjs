#!/usr/bin/env node
/**
 * scan every stored session on THIS HOST for credential values.
 *
 * `test/reconstruction/no_secrets.test.ts` proves the rule against a synthetic store with a known
 * canary. This is the other half: the same question asked of the real records that actually exist,
 * because the property that matters is "no credential is in the record", not "no credential is in a
 * record we built for the test".
 *
 * Reads the raw FILES, not the store API — a scan that goes through the reader could be fooled by
 * the reader. Refused/moved-aside stores are scanned too: they are still on disk, so they still
 * count.
 *
 * Exits 1 if anything matches, so it can be wired as a gate.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.HARNESS_STORE_DIR ?? join(homedir(), ".local/state/clawdparty/sessions");

/**
 * Shapes that would be an actual credential, not merely a mention of one.
 *
 * Each is anchored on a vendor's own prefix so a NAME like `env:ANTHROPIC_API_KEY` — which the
 * record is REQUIRED to contain  — cannot match. A pattern loose enough
 * to hit the source identity would fail on every healthy store and get muted, which is the failure
 * mode a scanner has to avoid.
 */
const PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "OpenAI API key", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // A 40-char base64-ish run following an aws secret hint. Deliberately hint-anchored: a bare
  // 40-char token matches hashes, shas and base64 payloads, and a scanner that cries wolf is a
  // scanner nobody reads.
  { name: "AWS secret access key", re: /aws_secret_access_key["'\s:=]+[A-Za-z0-9/+=]{40}/gi },
  { name: "AWS session token", re: /\b(?:FwoG|IQoJ)[A-Za-z0-9/+=]{50,}/g },
  {
    name: "OAuth bearer JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { name: "Claude OAuth token", re: /sk-ant-oat[A-Za-z0-9_-]{10,}/g },
];

let files;
try {
  files = readdirSync(dir).filter((f) => f.includes(".sqlite3"));
} catch (err) {
  console.error(`cannot read ${dir}: ${err.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.log(`no stores in ${dir} — nothing to scan`);
  process.exit(0);
}

console.log(`scanning ${files.length} store file(s) in ${dir}`);
let findings = 0;
let bytes = 0;

for (const file of files) {
  const path = join(dir, file);
  // latin1, not utf8: a credential must not slip through because a byte sequence upstream of it
  // was invalid UTF-8 and the decoder replaced a span containing it.
  const text = readFileSync(path).toString("latin1");
  bytes += text.length;

  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      findings += 1;
      // The MATCHED KIND and where, never the value — printing it would put the credential in a
      // log, which is the thing being tested for.
      console.error(`  FOUND ${name} in ${file} at byte ${match.index} (value withheld)`);
    }
  }
}

console.log(`scanned ${(bytes / 1024).toFixed(0)} KiB across ${files.length} file(s)`);
if (findings > 0) {
  console.error(`FAIL — ${findings} credential-shaped value(s) in stored records `);
  process.exit(1);
}
console.log("PASS — no credential-shaped value in any stored record ");
