> **Contract-neutral, additive.** Builds on `no-git-chat-mode` (`mode` + `repository_path`) and reuses the
> `RepoBrowser` realpath-containment rule. No event types / envelope / run-status change.

## 1. Shared containment helper (api)

- [ ] 1.1 Extract the realpath-containment check (resolve against `Git::WorktreeManager.repo_root`, refuse unless the resolved path stays inside; handle ENOENT/ENOTDIR/ELOOP → refuse) into one place (e.g. `RepoPaths.contain!(relative) -> absolute` or a module method)
- [ ] 1.2 Point `RepoBrowser#content` containment and `SessionsController` chat-dir validation at the shared helper (no behavior change — existing repo_browser + sessions specs stay green)

## 2. Directory listing endpoint (api)

- [ ] 2.1 `DirectoriesController#index` — `GET /api/directories?path=` : contain the path, list immediate subdirectories (name, relative path, `is_git_repo` = has a `.git` entry), no recursion; `require_user`
- [ ] 2.2 Route under `/api`; escaping path → client error (404/422); blank path → repo root
- [ ] 2.3 Request specs: lists subdirs with `is_git_repo`; `../`/absolute/symlink escape refused; unauthenticated refused

## 3. Change working directory (api)

- [ ] 3.1 `SessionsController#update` (`PATCH /api/sessions/:id`) — owner-gated (SessionPolicy `manage_invites`-style / a `manage_session` action), update `repository_path` via the shared containment helper; non-participant/unknown → 404; escaping dir → client error
- [ ] 3.2 Route (`resources :sessions, only: [:create, :update]`); request specs: owner changes dir (next run uses it); non-owner 403; cross-session 404; escaping dir refused

## 4. Web folder picker

- [ ] 4.1 `components/directory_picker.tsx` — fetch `GET /api/directories?path=`, render current path + up/parent + subfolder list (git marker), call back with the chosen relative path; text-field fallback on fetch error
- [ ] 4.2 Create form (landing): replace the free-text working-directory field with the picker for BOTH review and chat modes
- [ ] 4.3 Session page: owner-only "change directory" control opening the picker → `PATCH /api/sessions/:id`
- [ ] 4.4 Vitest + MSW: navigate in/out, pick a folder, git marker shown; `PATCH` on change; escape/error → text-field fallback; Biome + tsc clean

## 5. Validation

- [ ] 5.1 `openspec validate directory-picker --type change --strict` passes
- [ ] 5.2 All suites green: `api` (RSpec + RuboCop), `web` (Biome + tsc + Vitest); sidecar untouched
- [ ] 5.3 Live smoke: create a session by PICKING a folder (review → a git subdir; chat → any subdir); start a run and confirm it uses that cwd; as owner, change the directory and confirm the next run uses the new one; a `../` escape is refused
