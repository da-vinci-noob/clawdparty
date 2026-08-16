// Harness configuration, read entirely from the environment. No Rails host is
// hard-coded (keeps remote/Tailscale a future drop-in), and NO credential or
// auth-method selection lives here — discovery reports the winning source
// (providers/credentials/discover.ts) and the value never reaches this file.

import { homedir } from "node:os";
import { join } from "node:path";

export interface HarnessConfig {
  port: number;
  // harness -> Rails callback base URL. DISTINCT from HARNESS_URL (the
  // Rails -> harness address); the two directions are never conflated.
  railsInternalUrl: string;
  sharedSecret: string;
  heartbeatIntervalMs: number;
  sigtermFlushTimeoutMs: number;
  /**
   * Where the per-session SQLite stores live. Defaults OUTSIDE any project tree:
   * the record is the harness's, not the repo's, and a store under a worktree
   * would be committed by an approve, reverted by a reject, or deleted with the
   * worktree.
   */
  storeDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  return {
    port: Number.parseInt(env.HARNESS_PORT ?? "8787", 10),
    railsInternalUrl: env.RAILS_INTERNAL_URL ?? "http://rails:3000",
    sharedSecret: env.HARNESS_SHARED_SECRET ?? "",
    heartbeatIntervalMs: Number.parseInt(env.HEARTBEAT_INTERVAL_MS ?? "5000", 10),
    sigtermFlushTimeoutMs: Number.parseInt(env.SIGTERM_FLUSH_TIMEOUT_MS ?? "3000", 10),
    storeDir: env.HARNESS_STORE_DIR ?? join(homedir(), ".local", "state", "clawdparty", "sessions"),
  };
}
