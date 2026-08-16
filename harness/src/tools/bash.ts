import { type ChildProcess, spawn } from "node:child_process";
import { type ToolContext, type ToolDefinition, type ToolResult, textResult } from "./registry.js";
import { bashInvocation } from "./sandbox.js";
import { toolchainEnv } from "./toolchain.js";

/**
 * The `bash` tool.
 *
 * Canonical SCHEMA-LESS declaration — `{ type: "bash_20250124", name: "bash" }`
 * with no `input_schema`. The provider knows this tool's shape; supplying a
 * schema changes its identity.
 *
 * `ReplayPolicy: "never"`, and this is the case worth stating plainly: after a
 * crash mid-`bash`, the transcript gets a synthetic interrupted result and the
 * command is NOT re-run. Arbitrary side effects cannot be known safe, so
 * "coherent transcript, nothing executed twice" beats "probably fine".
 *
 * THERE IS NO INPUT PATH TO THIS SHELL FROM A PARTICIPANT. The terminal pane is a
 * read-only replay of these events. Under Q6 the harness runs on the host, so an
 * accidental input path would be local code execution, not a container escape —
 * which is why `no_shell_input.test.ts` asserts it structurally.
 */

export const BASH_TIMEOUT_MS = 120_000;
export const BASH_MAX_OUTPUT_BYTES = 512 * 1024;
/** One `terminal_output` event per chunk, matching the Contract-1 payload note. */
export const OUTPUT_CHUNK_BYTES = 64 * 1024;

export interface BashInput {
  command?: string;
  restart?: boolean;
}

/**
 * A persistent session would hold shell state across calls. Not implemented: each
 * call is its own process, so `cd` does not persist. Stated because the provider
 * tool contract permits a persistent session and a reader would otherwise assume
 * one exists.
 */
export class BashTool {
  private current: ChildProcess | null = null;
  /** Warn ONCE per process, not once per command — a per-call warning is noise. */
  private warnedUnavailable = false;

  readonly definition: ToolDefinition = {
    name: "bash",
    replay: "never",
    schema: { type: "bash_20250124", name: "bash" },
    run: (input, ctx) => this.run(input as BashInput, ctx),
  };

  async run(input: BashInput, ctx: ToolContext): Promise<ToolResult> {
    // `restart` is handled BEFORE `command`: a call carrying both means "reset,
    // then run", and checking command first would run against the old state.
    if (input.restart) {
      this.killCurrent();
      if (!input.command) return textResult("bash session restarted");
    }

    const command = input.command;
    if (!command) return textResult("bash requires a `command`", true);

    return this.execute(command, ctx);
  }

  private execute(command: string, ctx: ToolContext): Promise<ToolResult> {
    return new Promise((resolvePromise) => {
      // `command` stays a standalone array element in BOTH the plain and sandboxed
      // shapes — never interpolated into the invocation (no_shell_input.test.ts).
      const invocation = bashInvocation(command);
      if (invocation.unavailable && !this.warnedUnavailable) {
        this.warnedUnavailable = true;
        process.stderr.write(`[harness] ${invocation.unavailable}; running bash unsandboxed\n`);
      }
      const child = spawn(invocation.bin, invocation.args, {
        cwd: ctx.cwd,
        // stdin is closed, not inherited: a command that reads stdin gets EOF
        // rather than blocking forever on a stream nobody can write to.
        stdio: ["ignore", "pipe", "pipe"],
        env: toolchainEnv(process.env),
      });
      this.current = child;

      let combined = "";
      let truncated = false;
      let pending = "";
      let timedOut = false;

      const emit = (chunk: string) => {
        if (combined.length < BASH_MAX_OUTPUT_BYTES) {
          combined += chunk;
          if (combined.length > BASH_MAX_OUTPUT_BYTES) {
            combined = combined.slice(0, BASH_MAX_OUTPUT_BYTES);
            truncated = true;
          }
        } else {
          truncated = true;
        }

        pending += chunk;
        while (pending.length >= OUTPUT_CHUNK_BYTES) {
          ctx.onOutput?.(pending.slice(0, OUTPUT_CHUNK_BYTES));
          pending = pending.slice(OUTPUT_CHUNK_BYTES);
        }
      };

      // stdout and stderr are INTERLEAVED into one stream, matching what a human
      // sees in a terminal. Separating them reorders cause and effect.
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);

      const timer = setTimeout(() => {
        timedOut = true;
        this.killCurrent();
      }, BASH_TIMEOUT_MS);

      const onAbort = () => this.killCurrent();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (exitCode: number | null, signal: string | null) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        this.current = null;
        if (pending.length > 0) ctx.onOutput?.(pending);

        const notes: string[] = [];
        if (timedOut) notes.push(`timed out after ${BASH_TIMEOUT_MS}ms`);
        if (truncated) notes.push(`output truncated at ${BASH_MAX_OUTPUT_BYTES} bytes`);
        if (signal && !timedOut) notes.push(`killed by ${signal}`);

        const failed = timedOut || (exitCode !== null && exitCode !== 0) || signal !== null;
        const suffix = notes.length > 0 ? `\n[${notes.join("; ")}]` : "";
        const status = exitCode === null ? "" : `\n[exit ${exitCode}]`;

        resolvePromise(textResult(`${combined}${status}${suffix}`.trim(), failed));
      };

      child.on("error", (err) => finish(null, `spawn failed: ${String(err)}`));
      child.on("close", (code, signal) => finish(code, signal));
    });
  }

  private killCurrent(): void {
    if (!this.current) return;
    // Negative pid would signal the group, but we did not detach, so kill the
    // child and let bash tear down its own children.
    this.current.kill("SIGKILL");
    this.current = null;
  }
}
