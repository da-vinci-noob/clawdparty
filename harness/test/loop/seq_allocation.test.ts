import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One seq allocator per run, enforced rather than documented.
 *
 * `normalize.ts` has said "seq is assigned HERE and nowhere else... Splitting that decision
 * across producers is how a gap or a duplicate gets introduced" since it was written. The
 * rule was right and the code broke it TWICE — once in `planTools`/`reserveForRequest` and
 * once in the per-call tool-result write — because a comment cannot fail a build. Both times
 * the symptom was the same and silent: a second allocator read `MAX(seq)` while the
 * normalizer's rows were still uncommitted, handed back an id the normalizer was about to
 * use, and `UNIQUE (run_id, seq)` dropped the write with no error.
 *
 * The primary enforcement is now the TYPE: `LoopStore` omits `allocateSeq`, so loop code
 * calling it does not compile. This file covers the one hole a type cannot close —
 * open-coding the allocation as `highestSeq(...) + 1`.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    try {
      return sourceFiles(path);
    } catch {
      return path.endsWith(".ts") ? [path] : [];
    }
  });
}

const loopFiles = sourceFiles(join(SRC, "loop"));
const read = (path: string) => readFileSync(path, "utf8");

describe("the loop cannot allocate a seq", () => {
  it("has loop files to check, so this is not vacuously true", () => {
    expect(loopFiles.length).toBeGreaterThan(0);
  });

  it("never calls allocateSeq — enforced by LoopStore, asserted here too", () => {
    // A member CALL, not the bare word: the first version of this matched a comment in
    // run_loop.ts explaining why allocateSeq is unavailable, which is the opposite of a
    // violation. A guard that flags its own documentation gets deleted.
    const offenders = loopFiles.filter((path) => /\.allocateSeq\s*\(/.test(read(path)));

    // Belt and braces: the type already makes this a compile error. Kept because the type
    // could be widened by someone who does not know why it is narrow, and a widening looks
    // innocuous in review.
    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("never open-codes the allocation as highestSeq() + 1", () => {
    const offenders = loopFiles.filter((path) => /highestSeq\([^)]*\)\s*\+\s*1/.test(read(path)));

    // The hole the type cannot close. `highestSeq` is a legitimate READ — the normalizer is
    // seeded from it — but adding one to it IS an allocation, and it reintroduces exactly
    // the bug the type was added to prevent.
    expect(offenders.map((p) => p.slice(SRC.length))).toEqual([]);
  });

  it("seeds the normalizer from highestSeq, which is the one legitimate read", () => {
    const body = read(join(SRC, "loop/run_loop.ts"));

    // Without this the suite above would pass with a loop that never seeds at all, and a
    // RESUMED run would restart its seq at 1 and collide with everything already written.
    expect(body).toMatch(/store\.highestSeq\(/);
  });

  it("keeps the counter in the normalizer, which is the only thing that increments it", () => {
    const normalizer = read(join(SRC, "loop/normalize.ts"));
    const increments = [...normalizer.matchAll(/\+\+this\.seq/g)];

    // Two sites and no more: the envelope assignment and `takeSeqs`. A third would mean
    // something else in the file is minting ids on its own.
    expect(increments).toHaveLength(2);
  });
});
