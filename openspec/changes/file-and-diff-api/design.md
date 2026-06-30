## Context

These are the read APIs the review loop needs, and they are the most security-sensitive surface in the app: the
file content API reads arbitrary paths from a repo an LLM is actively editing. `CLAUDE.md` pins the
`RepoBrowser` rules precisely (tree from `git ls-files --cached --others --exclude-standard`; realpath
containment defeating `../` and symlinks; a denylist `.env*`/`*.pem`/`*.key`/`id_rsa*`/`*secret*`/`.git/`; a 1MB
cap; null-byte binary detection), and `docs/PLAN.md §13` lists path traversal as a must-test. The diff API has
its own gotcha: untracked files (a new file Claude created) won't show in `git diff HEAD` unless added with
`--intent-to-add` first, and the frozen `http-api-contract` requires diffs over REST, never cable.

The APIs operate on the session worktree (`run-orchestration`/`worktree-management`) and diff against the run's
`base_sha`. They are `SessionPolicy`-gated to view (all roles can read), with cross-session access returning
`404` (anti-enumeration), consistent with `rails-foundation`.

Spike-independent: files and git diffs, no event payloads.

## Goals / Non-Goals

**Goals:**
- `RepoBrowser`: the single safe chokepoint for file content — containment + denylist + cap + binary detection;
  tree from `git ls-files`.
- File tree + content endpoints, view-gated, all content through `RepoBrowser`.
- Diff API vs `base_sha` with `--intent-to-add` so untracked files count; REST-only.
- Request specs as the security backstop: traversal, denylist, untracked-file diff, cross-session `404`.

**Non-Goals:**
- The changeset approve=commit / reject=revert service + git edge-case units — W3 (this is the read surface it
  builds on; the reset operation itself lives in `worktree-management`).
- The diff viewer / file tree UI — W3 frontend.
- Any write to the repo, any run/event behavior.
- Submodule / multi-repo handling — scoped out per `docs/PLAN.md` (no-submodule-repos scoping).

## Decisions

**1. `RepoBrowser` is the one chokepoint; every content read goes through it.** No controller reads a file
directly. *Why:* a single audited path is how the containment + denylist + cap + binary rules are guaranteed —
`CLAUDE.md` makes `RepoBrowser` the named owner of these. *Structure:* `tree(session)` → `git ls-files --cached
--others --exclude-standard` (tracked + untracked-not-ignored, no `.git`); `content(session, path)` → the safety
pipeline below.

**2. Realpath containment, computed before reading.** Resolve the requested path against the worktree root with
realpath (following symlinks and collapsing `..`), then assert the resolved absolute path is still inside the
worktree root; otherwise refuse. *Why:* defeats both `../escape` and a symlink pointing outside the repo — the
classic traversal/IDOR vectors. *Order:* containment is checked on the resolved path, not the raw input, so a
symlink can't smuggle an escape past a string check.

**3. Denylist + cap + binary detection, after containment.** Even inside the worktree, refuse denylisted names
(`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`, anything under `.git/`); refuse files over 1MB; detect binary
by null byte and refuse (or mark) rather than streaming raw bytes as text. *Why:* the repo Claude edits may
contain secrets or huge/binary files; the review UI needs text diffs, not credential exposure. *Statuses:*
traversal/denylist/not-found → `404` (don't confirm a denied path's existence beyond "not available"); oversized
→ `413`; binary → `415`; so the client renders "not shown" cleanly.

**4. Diff uses `git add --intent-to-add -A` then `git diff HEAD`.** Compute the run diff in the worktree as
`git add --intent-to-add -A && git diff HEAD --numstat` (stats) + `git diff HEAD` (patch), so untracked new
files are counted and shown. Diff is vs the worktree HEAD relative to `base_sha`. *Why:* the frozen invariant —
"`git add --intent-to-add -A && git diff HEAD --numstat` so untracked files are counted"; without it a new file
Claude wrote is invisible in review, the exact W3 dogfood bug the plan flags. `--intent-to-add` stages only the
*intent* (path), not content, so it doesn't mutate the tree's content state.

**5. Diff is REST-only.** `GET /api/runs/:id/diff` returns the diff over REST; no diff is ever broadcast over
cable. *Why:* frozen `http-api-contract` (diffs REST-only — the one large payload kept off the cable).

**6. View-gating + cross-session `404`.** All three endpoints are `SessionPolicy`-gated to `view` (all roles
read). A request for a session/run the requester is not a participant of returns `404`, not `403`
(anti-enumeration), per `rails-foundation`'s convention. *Why:* read access is broad (all roles review), but the
resource must not confirm existence across sessions.

**7. Security specs are the deliverable, not an afterthought.** Request specs assert: `../`/absolute/symlink
traversal refused; each denylist pattern refused; an oversized file refused; a binary file refused/marked; the
diff counts a freshly-created untracked file; cross-session access `404`. *Why:* `docs/PLAN.md §13` names path
traversal a must-test and the W3 security review re-checks it endpoint-by-endpoint; these specs are that backstop.

## Risks / Trade-offs

- **Path traversal / symlink escape (the headline risk).** *Mitigation:* realpath containment on the resolved
  path (Decision 2) + dedicated traversal specs (Decision 7); `RepoBrowser` is the only reader (Decision 1).
- **Secret exposure via file content.** *Mitigation:* denylist + the fact that the tree comes from `git ls-files`
  (so `.gitignore`'d secrets aren't even listed) + the cap/binary checks; specs assert denylisted files refuse.
- **Untracked files invisible in the diff.** *Mitigation:* `--intent-to-add` (Decision 4) + a spec that creates
  an untracked file and asserts it appears in the diff.
- **Large/binary files blowing up the response.** *Mitigation:* 1MB cap + null-byte detection → defined refusal;
  the client renders "not shown."
- **`--intent-to-add` leaving residue in the worktree.** It stages intent only; *mitigation:* the diff
  computation is read-only in effect, and the worktree reset (`worktree-management`) clears any staging on
  reject; a spec confirms the diff computation doesn't alter file content state.
- **Diff cost on a huge change.** *Mitigation:* numstat first (cheap) + per-file patch; pagination/caps are a
  later hardening note, not solved here, but the numstat gives the client a size signal.

## Open Questions

- None. (Previously open: the oversized/binary refusal status — now pinned to `413` (oversized) and `415`
  (binary) in the `repo-browser`/`file-api` specs, so the security request spec can assert concrete codes.)
