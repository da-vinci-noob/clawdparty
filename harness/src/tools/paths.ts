import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * The single realpath-containment rule for tool file access — the TypeScript
 * counterpart of Rails' `RepoPaths` + `RepoBrowser`. Both sides must agree, or a
 * path the API refuses to show becomes a path a tool will happily write.
 *
 * `realpath` follows symlinks and collapses `..`, so containment is checked on
 * the RESOLVED path. Checking the requested string instead is the classic hole:
 * `a/../../etc/passwd` and a symlink to `/etc` both look contained until resolved.
 */

export class Escape extends Error {}
export class Oversized extends Error {}
export class BinaryContent extends Error {}

export const MAX_BYTES = 1024 * 1024;

/**
 * Secret/sensitive denylist, matched on the BASENAME plus `.git/` internals.
 * Kept identical to `RepoBrowser::DENYLIST_BASENAME`.
 */
const DENYLIST_BASENAME: RegExp[] = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/, /secret/i];

export function isDenylisted(requestedPath: string): boolean {
  if (requestedPath.split(/[/\\]/).includes(".git")) return true;
  const base = basename(requestedPath);
  return DENYLIST_BASENAME.some((pattern) => pattern.test(base));
}

/**
 * Resolve an EXISTING path against `root`, returning the resolved absolute path.
 * Throws `Escape` on traversal, symlink escape, or a missing path.
 */
export function containExisting(root: string, requestedPath: string): string {
  const realRoot = realpathOrThrow(root);
  const candidate = resolveAgainst(realRoot, requestedPath);
  const resolved = realpathOrThrow(candidate);
  if (!contains(realRoot, resolved)) throw new Escape("escapes root");
  return resolved;
}

/**
 * Resolve a path that MAY NOT EXIST YET — the `create` case.
 *
 * A file being created has no realpath of its own, and neither do the directories
 * `create` is allowed to make for it. So this walks UP to the DEEPEST EXISTING
 * ancestor, realpaths that, and requires it to be contained. Only realpathing the
 * immediate parent would reject every nested create; not realpathing at all would
 * let a symlinked ancestor escape.
 *
 * The still-to-be-created segments are then checked to be plain names. That check
 * is what stops the walk from re-introducing traversal after containment has
 * already been decided — `resolve()` has collapsed any `..` by this point, so a
 * surviving one would mean something is wrong upstream.
 */
export function containForCreate(root: string, requestedPath: string): string {
  const realRoot = realpathOrThrow(root);
  const candidate = resolveAgainst(realRoot, requestedPath);

  const base = basename(candidate);
  if (base === "" || base === "." || base === "..") throw new Escape("not a file path");

  const { existingAncestor, missing } = splitAtExisting(candidate);
  const realAncestor = realpathOrThrow(existingAncestor);
  if (!contains(realRoot, realAncestor)) throw new Escape("parent escapes root");
  if (missing.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Escape("unresolvable path");
  }

  const target = missing.length === 0 ? realAncestor : [realAncestor, ...missing].join(sep);

  // If the target already exists, hold it to the stricter existing-path rule: a
  // symlink AT the target could point outside even though its parent is contained.
  try {
    statSync(target);
    return containExisting(realRoot, target);
  } catch {
    return target;
  }
}

/** Split an absolute path into its deepest existing ancestor plus the rest. */
function splitAtExisting(absolutePath: string): { existingAncestor: string; missing: string[] } {
  const missing: string[] = [];
  let cursor = absolutePath;

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    // Reached the filesystem root without finding anything that exists.
    if (parent === cursor) throw new Escape("unresolvable path");
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return { existingAncestor: cursor, missing };
}

/**
 * The READ pipeline: denylist, then the size cap, then file-ness. Binary detection is
 * the caller's (it needs the bytes).
 *
 * Reads deliberately FOLLOW a symlink out of the worktree, which  requires
 * outright: "100% of symlinks that leave the project directory resolve correctly".
 * Real projects depend on it — a pnpm workspace links `node_modules/<pkg>` to a store
 * outside the repo, and `npm link` does the same. In a container those mostly failed to
 * resolve at all and the mount set was the boundary; on the host they resolve, and
 * refusing them would break ordinary repos while protecting nothing, because
 * model-directed `bash` can already read anything the developer can. The DENYLIST
 * is the real protection for reads, and it still applies to every path.
 *
 * WRITES are a different question — see `assertWritable`.
 */
export function assertReadable(root: string, requestedPath: string): string {
  if (isDenylisted(requestedPath)) throw new Escape("denylisted");
  // Still RESOLVED against the root — only the containment CHECK is dropped. A
  // relative path is relative to the session cwd; resolving it against
  // `process.cwd()` instead would make every relative read an ENOENT.
  const resolved = realpathOrThrow(resolveAgainst(realpathOrThrow(root), requestedPath));
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Escape("not a file");
  if (stat.size > MAX_BYTES) throw new Oversized(`exceeds ${MAX_BYTES} bytes`);
  return resolved;
}

/**
 * The WRITE pipeline for a file that must already exist. Unlike a read, this is
 * CONTAINED to the session worktree.
 *
 * The reason is review, not filesystem hygiene: approve commits the worktree and reject
 * runs `git reset --hard && git clean -fd` in it. A write that lands outside is invisible
 * to the diff and survives a reject, so the room would approve or reject a change set
 * that does not describe what happened. `bash` can still write anywhere — that is what
 * `tool:before` gates — but the file tools keep the reviewable surface honest.
 */
export function assertWritable(root: string, requestedPath: string): string {
  if (isDenylisted(requestedPath)) throw new Escape("denylisted");
  const resolved = containExisting(root, requestedPath);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Escape("not a file");
  if (stat.size > MAX_BYTES) throw new Oversized(`exceeds ${MAX_BYTES} bytes`);
  return resolved;
}

export function assertNotBinary(bytes: Buffer): void {
  if (bytes.includes(0)) throw new BinaryContent("binary content");
}

function resolveAgainst(realRoot: string, requestedPath: string): string {
  // An ABSOLUTE request is kept as-is and checked for containment; a relative one
  // resolves against the root. Joining unconditionally would double-prefix an
  // absolute path and turn a genuine escape into a confusing not-found.
  return isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(realRoot, requestedPath);
}

function contains(root: string, resolved: string): boolean {
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}

function realpathOrThrow(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // ENOENT, ENOTDIR, ELOOP all land here and are all "unresolvable".
    throw new Escape("unresolvable path");
  }
}
