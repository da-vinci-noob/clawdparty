import { defineConfig } from "vitest/config";

/**
 * The performance gate, run ALONE.
 *
 * `fileParallelism: false` and a single fork: the whole point is an uncontended measurement, and
 * the default config excludes this file for the same reason. A percentile measured while 77 other
 * test files fight for the same disk is a measurement of the machine, not of the store.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/store/write_cost.test.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
