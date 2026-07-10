> **Contract-neutral, additive.** `review` mode is unchanged; the sidecar is untouched (it already runs in the
> `cwd` it is handed). Depends on `session-create` (extends the create form/endpoint), `run-orchestration`
> (Runs::Start/Finalize), and `worktree-management` (skipped in chat mode).

## 1. Data model + session create

- [ ] 1.1 Migration: add `sessions.mode` (string, default `'review'`, null: false); annotate the model
- [ ] 1.2 `Session` model: `enum :mode, %w[review chat]` (validate); document `repository_path` as "the session working directory" (git repo in review, plain dir in chat)
- [ ] 1.3 `SessionsController#create`: accept `mode` (default `review`) + working directory; for `chat`, realpath-contain the directory within the mounted repo root (reuse the RepoBrowser containment rule) — refuse an escaping path with a client error; default an omitted dir to the repo root
- [ ] 1.4 Request specs: default create is `review`; `chat` create persists mode + dir; an escaping dir is refused and nothing is created; omitted dir defaults to the repo root

## 2. Run start/finalize branch on mode (api)

- [ ] 2.1 `Runs::Start`: for `chat`, skip `ensure_worktree!`/`dirty?`/`base_sha` and pin the sidecar `cwd` to the session working directory; `review` path unchanged; one-active-run enforced in both
- [ ] 2.2 `Runs::Finalize`: for a `chat` run, `run_finished` → `completed_clean` and `run_interrupted` → `completed_clean` (never `awaiting_review`); `run_failed` → `failed` unchanged
- [ ] 2.3 Service/request specs: a chat run starts with no worktree + no `base_sha`, `cwd` = working dir; a non-git chat dir still starts (no `GitError`); a chat `run_finished` → `completed_clean` (not `awaiting_review`); a second concurrent chat start → one-active-run conflict; `review` behavior unchanged

## 3. Web (create form + mode-aware UI)

- [ ] 3.1 Landing "Create" form: add a mode toggle (review/chat) + a working-directory field (shown for chat); post `mode` + directory to `POST /api/sessions`
- [ ] 3.2 Session page: for a `chat` session, omit the diff/approval affordances; keep the activity feed, prompt composer, interrupt, and chat identical (mode-agnostic). Surface the session mode in the store/current participant context as needed
- [ ] 3.3 Vitest: a chat session renders the feed/composer but not the approval UI; create-form posts the mode + directory

## 4. Docs + validation

- [ ] 4.1 If session-create's request shape is treated as part of the frozen `http-api-contract`, add an additive `docs/contracts/CHANGELOG.md` note (optional `mode` + working-directory field on create); confirm NO event type / envelope / run-status change
- [ ] 4.2 `openspec validate no-git-chat-mode --type change --strict` passes
- [ ] 4.3 All suites green: `api` (RSpec + RuboCop), `web` (Biome + tsc + Vitest); `sidecar` untouched (no change expected)
- [ ] 4.4 Live smoke: create a `chat` session pointing at a non-git directory under the repo root → start a run → events stream (run_started → ai_text → run_finished → `completed_clean`); confirm no worktree was created and no approval prompt appears
