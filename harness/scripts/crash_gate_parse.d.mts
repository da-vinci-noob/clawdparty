// The gate runs under bare `node`, so the parser stays .mjs; this is what lets the test import it
// under `tsc --noEmit` without loosening `noImplicitAny` for the whole scripts directory.
export declare function parseSummary(output: string): { passed: number; skipped: number } | null;
