import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * there is NO input path from a participant to a shell, and the terminal
 * event stream is emit-only.
 *
 * This matters more after the harness moves onto the host. In a container an
 * accidental input path is a container escape someone still has to work at; on the
 * host it is direct code execution as the developer, against their real filesystem,
 * credentials, and SSH agent. The blast radius changed, so the assertion has to be
 * structural rather than a convention someone remembers.
 *
 * These are SOURCE assertions rather than behavioural ones on purpose. A behavioural
 * test proves the routes that exist today are safe; this proves no route was ADDED
 * that takes shell input, which is the change actually worth catching.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles();
const read = (path: string) => readFileSync(path, "utf8");

/**
 * Files permitted to start a process. Adding a row should require arguing for it;
 * the list is short so the argument is visible in review.
 *
 * `bash.ts` spawns a shell. `glob.ts`/`grep.ts` run git in ARGV form, which cannot
 * be injected through its arguments.
 */
const PROCESS_STARTERS = ["tools/bash.ts", "tools/glob.ts", "tools/grep.ts"];

/**
 * Detected by the child_process IMPORT, not by method name.
 *
 * A substring search for `exec(` was the first attempt and it produced two false
 * positives — `regex.exec(line)` in capabilities.ts and `db.exec(sql)` in store.ts,
 * neither of which starts a process. A security test that cries wolf gets weakened
 * or deleted, so the signal has to be exact.
 */
const CHILD_PROCESS_IMPORT = /from "node:child_process"/;

describe("no shell input path exists", () => {
  it("starts a process from exactly three files, all of them tools", () => {
    const starters = files
      .filter((f) => CHILD_PROCESS_IMPORT.test(read(f)))
      .map((f) => f.slice(SRC.length))
      .sort();

    expect(starters).toEqual(PROCESS_STARTERS);
    // No route handler, transport, store or extension point may start a process.
    for (const starter of starters) {
      expect(starter.startsWith("tools/"), `${starter} is outside tools/`).toBe(true);
    }
  });

  it("uses argv form for git, never a shell string", () => {
    // Argv form cannot be injected through its arguments; `exec("git " + input)`
    // can. Both tools take a caller-supplied pattern, so this is what keeps them
    // safe. They call git through a promisified execFile alias, so the assertion is
    // on the import and the call shape rather than on a literal `execFile(` call.
    for (const file of ["tools/glob.ts", "tools/grep.ts"]) {
      const body = read(join(SRC, file));

      expect(body, `${file} must import execFile, not exec`).toMatch(
        /import \{ execFile \} from "node:child_process"/,
      );
      expect(body, `${file} must not import the shell-string exec`).not.toMatch(
        /import \{[^}]*\bexec\b[^}]*\} from "node:child_process"/,
      );
      // The command string must be EXACTLY "git" with arguments passed separately —
      // either inline or as a prebuilt array. A space inside it ("git " + …) would
      // mean arguments were concatenated into the command, which is the injectable
      // shape.
      expect(body, `${file} must invoke the bare "git" binary`).toMatch(/\(\s*\n?\s*"git",/);
      expect(body, `${file} must not concatenate args into the command`).not.toMatch(/"git\s/);
      expect(body, `${file} must not enable a shell`).not.toMatch(/shell:\s*true/);
    }
  });

  it("passes bash a fixed argv and never interpolates into the shell invocation", () => {
    const body = read(join(SRC, "tools/bash.ts"));
    const sandbox = read(join(SRC, "tools/sandbox.ts"));

    // The command reaches bash as an ARGUMENT to `-lc`, which is the model's own tool
    // call — the documented, gated path. What must never appear is the command spliced
    // into the invocation itself.
    //
    // The argv is now BUILT by sandbox.ts (the optional sandbox-exec wrapper prepends
    // to it), so the assertion moved from a literal spawn call to the property that
    // matters: `command` is a standalone array element in every shape, and neither file
    // ever builds an invocation by interpolation.
    expect(body).toMatch(/spawn\(invocation\.bin, invocation\.args/);
    for (const [name, source] of [
      ["bash.ts", body],
      ["sandbox.ts", sandbox],
    ] as const) {
      expect(source, `${name} interpolates into a spawn call`).not.toMatch(/spawn\(\s*`/);
      expect(source, `${name} enables a shell`).not.toMatch(/shell:\s*true/);
      // No template literal or concatenation may CONTAIN the command — the shapes that
      // would turn a tool argument back into part of the command line.
      expect(source, `${name} embeds command in a template literal`).not.toMatch(
        /`[^`]*\$\{command\}/,
      );
      expect(source, `${name} concatenates command into a string`).not.toMatch(
        /["'][^"']*"\s*\+\s*command/,
      );
    }

    // Both shapes end with the command as its own element, after `-lc`.
    expect(sandbox).toMatch(/args: \["-lc", command\]/);
    expect(sandbox).toMatch(/"-lc",\n\s*command,/);
  });

  it("closes stdin on the spawned shell rather than inheriting it", () => {
    const body = read(join(SRC, "tools/bash.ts"));

    // "ignore" for stdin is what makes a command that reads stdin get EOF instead of
    // waiting on a stream. An inherited stdin would be a channel into the shell.
    expect(body).toMatch(/stdio:\s*\["ignore"/);
    expect(body).not.toMatch(/stdio:\s*"inherit"/);
  });

  it("exposes no HTTP route that carries a command", () => {
    const body = read(join(SRC, "index.ts"));
    const routes = [...body.matchAll(/app\.(get|post|put|patch|delete)[^(]*\(\s*"([^"]+)"/g)].map(
      (m) => m[2],
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route, `route ${route} names a shell concept`).not.toMatch(
        /exec|shell|command|terminal|bash|pty|tty/i,
      );
    }
  });

  it("reads no command, shell or argv field off a request body", () => {
    const body = read(join(SRC, "index.ts"));

    // A participant's request may carry a prompt or a message. It may never carry
    // something the harness would hand to a shell.
    for (const field of ["command", "shell", "argv", "cmd", "script", "exec"]) {
      expect(body, `index.ts reads req.body.${field}`).not.toMatch(
        new RegExp(`body\\s*(as[^;]*)?\\)?\\.${field}\\b`),
      );
    }
  });
});

describe("the terminal stream is emit-only", () => {
  it("offers an output callback and no input counterpart", () => {
    const registry = read(join(SRC, "tools/registry.ts"));

    expect(registry).toMatch(/onOutput\?:/);
    // The absence is the assertion. A ToolContext that could accept input would make
    // the terminal pane bidirectional, and the read-only replay is the invariant.
    for (const name of ["onInput", "sendInput", "stdin"]) {
      expect(registry, `registry exposes ${name}`).not.toContain(name);
    }
  });

  it("never writes to a child process's stdin", () => {
    for (const file of files) {
      const body = read(file);
      expect(body, `${file.slice(SRC.length)} writes to stdin`).not.toMatch(
        /\.stdin[?.]*\.(write|end)\(/,
      );
    }
  });

  it("declares terminal_output as harness-produced, with no inbound counterpart", async () => {
    const { EVENT_TYPES } = await import("@clawdparty/contracts");

    expect(EVENT_TYPES).toContain("terminal_output");
    // There is no `terminal_input` and there must never be one: the taxonomy is the
    // shared vocabulary, so an input event type is how a shell channel would first
    // become expressible.
    expect(EVENT_TYPES).not.toContain("terminal_input");
    expect(EVENT_TYPES.filter((t) => t.includes("input"))).toEqual([]);
  });
});

describe("extension points cannot introduce a shell", () => {
  it("gives handlers no process, spawn or shell capability", () => {
    const points = read(join(SRC, "extensions/points.ts"));

    // A handler receives a context object and returns an Outcome. It is handed no
    // means of execution, which is what keeps `tool:before` a gate rather than a
    // second way in.
    expect(points).not.toMatch(CHILD_PROCESS_IMPORT);
    expect(points).not.toContain("child_process");
  });

  it("lets a handler refuse or transform, never execute", () => {
    const points = read(join(SRC, "extensions/points.ts"));

    expect(points).toMatch(/k:\s*"refuse"/);
    expect(points).toMatch(/k:\s*"replace"/);
    expect(points).toMatch(/k:\s*"continue"/);
  });
});
