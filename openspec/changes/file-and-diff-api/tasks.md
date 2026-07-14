> **Depends on `run-orchestration`** (the worktree + `base_sha` the diff is computed against) and
> `rails-foundation` (`SessionPolicy`, models, `/api` scope, 403-vs-404 convention). Spike-independent.

## 1. RepoBrowser (repo-browser)

- [x] 1.1 Implement `api/app/services/repo_browser.rb`: `tree(session)` from `git ls-files --cached --others --exclude-standard` (no `.git`, no ignored)
- [x] 1.2 `content(session, path)` pipeline — realpath containment FIRST: resolve against the worktree root (follow symlinks, collapse `..`), refuse unless contained
- [x] 1.3 Denylist (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`, `.git/`), 1MB cap, null-byte binary detection — each a defined refusal
- [x] 1.4 Unit/spec: `../`, absolute, and symlink-escape paths refused; each denylist pattern refused; oversized refused; binary detected

## 2. File API (file-api)

- [x] 2.1 `GET /api/sessions/:id/files` (tree) + `GET /api/sessions/:id/files/content?path=…` (content via RepoBrowser); routes under `/api`
- [x] 2.2 `SessionPolicy`-gate both to `view` (all roles); content refusals → `404` (traversal/denylist/not-found), `413` (oversized), `415` (binary)
- [x] 2.3 Cross-session access → `404` (not `403`)
- [x] 2.4 Request specs: allowed read `200`; traversal/denylist/not-found → `404`; oversized → `413`; binary → `415`; cross-session `404`

## 3. Diff API (diff-api)

- [x] 3.1 Implement `api/app/services/git/diff.rb`: in the worktree, `git add --intent-to-add -A` then `git diff HEAD --numstat` (stats) + `git diff HEAD` (patch) vs `base_sha`
- [x] 3.2 `GET /api/runs/:id/diff` — REST only (never cable); `SessionPolicy`-gate to `view`; cross-session `404`
- [x] 3.3 Confirm `--intent-to-add` stages intent only (no content mutation); repeated diffs consistent
- [x] 3.4 Request specs: a freshly-created untracked file appears in the diff; diff served over REST; view role allowed; cross-session `404`

## 4. Validation

- [x] 4.1 Run `openspec validate file-and-diff-api --type change --strict` and confirm valid
- [x] 4.2 Confirm the `api` suite (RuboCop + RSpec) stays green, including the traversal/denylist/untracked-diff security specs — *151 examples, 0 failures; RuboCop 79 files clean. Live: file tree/content + traversal-404 verified; the run diff picked up a freshly-created untracked file via intent-to-add over REST.*
