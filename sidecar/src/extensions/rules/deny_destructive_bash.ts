import { type Handler, PRIORITY, type ToolCallCtx } from "../points.js";

/**
 * The worked example for contributors, and the first thing that has ever been able
 * to refuse a command in this project.
 *
 * It is deliberately a BUNDLED rule registered through the same `tool:before`
 * contract a third-party plugin uses — no privileged path. If a bundled
 * rule needed a shortcut, the contract would already be rotting.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────
 * This is not a security boundary, and treating it as one would be the dangerous
 * misreading. Pattern-matching shell strings cannot be exhaustive: `rm -rf /` is
 * caught, `$(printf 'r''m') -rf /` is not, and a determined model or a malicious
 * prompt has unbounded ways to spell the same command. Containment comes from the
 * worktree, the path rules, and review — this catches the *obvious accident*, which
 * on the host is worth catching because the blast radius is the developer's machine.
 */

/**
 * Patterns matched against the whole command string. Each entry says what it is
 * for, because a bare regex list invites someone to "tidy" one away.
 */
const DESTRUCTIVE: Array<{ pattern: RegExp; why: string }> = [
  {
    // rm -rf against a root-ish path. `[/~]` covers / and $HOME.
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*[/~](\s|$)/,
    why: "recursive delete of / or $HOME",
  },
  {
    pattern: /\bgit\s+push\s+(--force|-f)\b/,
    why: "force-push (rewrites published history)",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    why: "hard reset (discards uncommitted work the reviewer has not seen)",
  },
  {
    pattern: /\b(mkfs|dd)\s/,
    why: "raw disk write",
  },
  {
    pattern: />\s*\/dev\/(sd|nvme|disk)/,
    why: "redirect onto a block device",
  },
  {
    // Reading a credential out of the harness's own environment.
    pattern: /\b(env|printenv|set)\b[^|;]*\|[^|;]*\b(grep|rg|awk)\b[^|;]*(KEY|TOKEN|SECRET)/i,
    why: "scraping credentials out of the environment",
  },
  {
    pattern: /\bcurl\b[^|;]*\|\s*(ba)?sh\b/,
    why: "piping a downloaded script straight into a shell",
  },
];

/** Sub-commands of the canonical text editor that write. */
const WRITING_EDITOR_COMMANDS = new Set(["create", "str_replace", "insert"]);

export const denyDestructiveBash: Handler<"tool:before"> = {
  id: "bundled:deny-destructive-bash",
  point: "tool:before",
  priority: PRIORITY.bundled,
  run: (ctx: ToolCallCtx) => {
    const command = commandOf(ctx);
    if (command === null) return { k: "continue", value: ctx };

    for (const { pattern, why } of DESTRUCTIVE) {
      if (pattern.test(command)) {
        // The reason reaches the shared feed as `tool_refused`, so everyone in the
        // room sees WHAT was refused and WHY — not just that something stalled.
        return { k: "refuse", reason: `refused: ${why}` };
      }
    }
    return { k: "continue", value: ctx };
  },
};

/**
 * Also refuses a write to a path outside the session worktree, as a second,
 * independent check.
 *
 * The tools already enforce realpath containment, so this is redundant on purpose:
 * the gate should not depend on the thing it is gating being correct. Registered
 * separately so a contributor can see that two rules on one point compose.
 */
export const denyOutOfTreeWrite: Handler<"tool:before"> = {
  id: "bundled:deny-out-of-tree-write",
  point: "tool:before",
  priority: PRIORITY.bundled,
  run: (ctx: ToolCallCtx) => {
    const args = (ctx.input ?? {}) as Record<string, unknown>;
    const command = String(args.command ?? "");
    if (!WRITING_EDITOR_COMMANDS.has(command)) return { k: "continue", value: ctx };

    const path = String(args.path ?? args.file_path ?? "");
    if (path.startsWith("/") && !path.startsWith(`${ctx.cwd}/`)) {
      return { k: "refuse", reason: "refused: absolute write outside the session worktree" };
    }
    if (path.split("/").includes("..")) {
      return { k: "refuse", reason: "refused: path traversal in a write" };
    }
    return { k: "continue", value: ctx };
  },
};

export const bundledRules = [denyDestructiveBash, denyOutOfTreeWrite];

function commandOf(ctx: ToolCallCtx): string | null {
  if (ctx.name !== "bash" && ctx.name !== "Bash") return null;
  const args = (ctx.input ?? {}) as Record<string, unknown>;
  const command = args.command;
  return typeof command === "string" ? command : null;
}
