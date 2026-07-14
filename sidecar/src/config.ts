// Sidecar configuration, read entirely from the environment. No Rails host is
// hard-coded (keeps remote/Tailscale a future drop-in), and NO Claude credential
// or auth-method selection lives here — the SDK auto-detects from the inherited
// host environment (see permissions.ts / claude-auth-passthrough).

export interface SidecarConfig {
  port: number;
  // sidecar -> Rails callback base URL. DISTINCT from SIDECAR_URL (the
  // Rails -> sidecar address); the two directions are never conflated.
  railsInternalUrl: string;
  sharedSecret: string;
  heartbeatIntervalMs: number;
  sigtermFlushTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  return {
    port: Number.parseInt(env.SIDECAR_PORT ?? "8787", 10),
    railsInternalUrl: env.RAILS_INTERNAL_URL ?? "http://rails:3000",
    sharedSecret: env.SIDECAR_SHARED_SECRET ?? "",
    heartbeatIntervalMs: Number.parseInt(env.HEARTBEAT_INTERVAL_MS ?? "5000", 10),
    sigtermFlushTimeoutMs: Number.parseInt(env.SIGTERM_FLUSH_TIMEOUT_MS ?? "3000", 10),
  };
}
