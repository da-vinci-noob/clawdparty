## Why

Reviewing Claude's work — the never-cut "diff review + approve/reject" MVP piece — needs two read APIs that
don't exist yet: a **file tree + content** browser (to see the repo Claude is working in) and a **diff API**
(to see what a run changed). These are the Week-2 Rails deliverables that feed the Week-3 diff viewer +
approval screen (`docs/PLAN.md §10`, Snehal: "file tree + content API with traversal request specs (1.5d);
diff API with intent-to-add (1d)").

They are **security-critical** in a way most of the app is not: the file content API reads arbitrary paths
from a repo that Claude (an LLM) is editing, so path-traversal and secret-exposure are real risks — `docs/PLAN.md
§13` lists path traversal as a must-test, and `CLAUDE.md` pins the `RepoBrowser` safety rules (realpath
containment, denylist, size cap, binary detection). The diff API has its own subtle correctness rule: untracked
files must be counted via `git add --intent-to-add` or a new file Claude created won't appear in the diff.

This change is **spike-independent** (it reads files and computes git diffs — no event payloads involved). It
depends on `run-orchestration` (the worktree + `base_sha` it diffs against) and `rails-foundation`
(`SessionPolicy`, the session/run models, the `/api` scope + error conventions).

## What Changes

- **`RepoBrowser`** — the safe file reader, encoding the `CLAUDE.md` rules: the tree comes from `git ls-files
  --cached --others --exclude-standard`; content reads use **realpath-containment** (resolve symlinks + `..`
  and confirm the result stays inside the worktree), a **denylist** (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `*secret*`, `.git/`), a **1MB cap**, and **null-byte binary detection**. Any path escaping the worktree or
  hitting the denylist is refused — never served.
- **`GET /api/sessions/:id/files`** — the file tree for the session's worktree (or repo), `SessionPolicy`-gated
  to view (all roles), built from `git ls-files`.
- **`GET /api/sessions/:id/files/content?path=…`** — a single file's content, run through `RepoBrowser`'s
  containment + denylist + cap + binary checks; refuses traversal/denylisted/oversized/binary with the
  appropriate status.
- **`GET /api/runs/:id/diff`** — the run's diff vs `base_sha`, computed with `git add --intent-to-add -A &&
  git diff HEAD --numstat` (so untracked files are counted) plus the per-file patch; served over **REST, never
  cable** (frozen `http-api-contract`). `SessionPolicy`-gated to view.
- **Request specs** that are the security backstop: path-traversal attempts (`../`, absolute paths, symlinks)
  refused; denylisted files refused; the diff counts a newly-created untracked file; cross-session access `404`.

This change adds read APIs only. It does **not** implement the changeset approve=commit / reject=revert service
(W3), the diff *viewer* UI (W3), or any run/event behavior. It is `RepoBrowser` + the file/diff endpoints.

## Capabilities

### New Capabilities
- `repo-browser`: `RepoBrowser` — the safe file tree (`git ls-files --cached --others --exclude-standard`) and
  content reader with realpath-containment, the secret denylist, the 1MB cap, and null-byte binary detection;
  the single chokepoint through which all file content is served.
- `file-api`: `GET /api/sessions/:id/files` (tree) and `GET /api/sessions/:id/files/content?path=…` (content),
  `SessionPolicy`-gated, routing all content through `RepoBrowser`; traversal/denylist/cap/binary refusals with
  defined statuses, and cross-session `404`.
- `diff-api`: `GET /api/runs/:id/diff` — the run diff vs `base_sha` using `git add --intent-to-add -A` so
  untracked files are counted, served over REST only, `SessionPolicy`-gated to view.

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed changes (rails-foundation, run-orchestration) are not archived into
     openspec/specs/. This ADDS read APIs on top of them without changing their requirements. -->

## Impact

- **New code:** `api/app/services/repo_browser.rb` (the safe reader), `api/app/services/git/diff.rb` (the
  intent-to-add diff), the file/diff controllers under `/api`, routes, and request specs — including the
  traversal/denylist security specs that are the highest-value tests here.
- **Consumes (does not modify):** `run-orchestration`/`worktree-management` (the worktree path + `base_sha` the
  diff is computed against), `rails-foundation` (`SessionPolicy` view-gating, session/run models, `/api` scope,
  `{ errors }` convention, the 403-vs-404 anti-enumeration rule), and the frozen `http-api-contract` (diffs
  REST-only, file tree/content endpoints in the surface).
- **Spike-independent:** reads files + computes git diffs; no event payloads. May proceed in parallel with the
  spike and the frontend changes.
- **Cross-stream:** feeds the W3 diff viewer + approval screen (which render `GET /api/runs/:id/diff` and the
  file tree). The changeset service that *acts* on a diff (approve=commit/reject=revert) is W3 and depends on
  this read surface + `worktree-management`'s reset.
- **Dependencies:** `rails-foundation`, `run-orchestration` (worktree + `base_sha`), `freeze-interface-contracts`.
