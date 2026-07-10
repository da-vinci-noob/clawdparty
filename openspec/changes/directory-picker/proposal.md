## Why

You can't pick which folder Claude works in from the browser, or change it later. A `review` session
always uses the fixed `/repo`; a `chat` session has a **free-text** "Working directory" field (no browser, no
validation feedback, easy to typo); and neither can change directory after creation. Users don't know which
paths are valid (the server filesystem isn't visible to the browser), so targeting a specific repo/subdir is
guesswork. Give both modes a real folder picker backed by a server directory listing, and let an owner change a
session's working directory.

## What Changes

- **`GET /api/directories?path=…`** — lists the immediate subdirectories under the mounted repo root for the
  given (relative) path, each flagged `is_git_repo`. The path is **realpath-contained** within the repo root
  (defeats `../` + symlink escape — the same rule `RepoBrowser` already uses); an escaping path is refused. This
  is how the browser "sees" server folders to navigate/pick. View-gated is not required (it lists only the
  bind-mounted repo area, the same trust boundary as the repo browser) — but it requires a valid participant
  cookie like every other `/api` read.
- **`PATCH /api/sessions/:id`** — owner-gated; updates the session's `repository_path` (the working directory),
  containment-checked, so **subsequent** runs use the new directory. (Does not retro-move an in-flight run; one
  active run per session still holds.)
- **Web — folder picker in the create form (both modes):** replace the free-text field with a browser that
  lists subdirectories (via `GET /api/directories`), lets you navigate in/out and pick a folder, and shows the
  git/non-git marker. Used for `review` (pick which repo) and `chat` (pick any dir). Falls back gracefully to a
  text field if the listing endpoint errors.
- **Web — change working directory on the session page:** an owner-only control to open the same picker and
  `PATCH` the session's directory (applies to the next run).

Contract-neutral: no event types, no envelope/protocol change. Purely additive REST endpoints + UI. Builds on
`no-git-chat-mode` (the `mode` + `repository_path` it introduced) and reuses the `RepoBrowser` containment rule.

## Capabilities

### New Capabilities
- `directory-picker`: the server directory-listing endpoint (`GET /api/directories`, containment-checked,
  git-repo-flagged), the owner-gated `PATCH /api/sessions/:id` to change the working directory, and the web
  folder-picker UI used in the create form (both modes) and to change a session's directory.

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed capabilities (session-create / no-git-chat-mode's mode +
     repository_path, file-and-diff-api's RepoBrowser containment, run-orchestration) are not archived into
     openspec/specs/. This ADDS a listing endpoint + a session-update endpoint + picker UI on top of them; the
     create request simply accepts the same `repository_path` it already does, now chosen via a picker. -->

## Impact

- **api:** a `DirectoriesController#index` (list contained subdirs + `is_git_repo`), a `SessionsController#update`
  (owner-gated `repository_path` change, containment-checked), routes, and request specs (listing under the
  root; `../`/symlink escape refused; non-owner update 403; cross-session 404; changed dir used by the next
  run). Reuse the realpath-containment helper (extract from `RepoBrowser`/`SessionsController` so both share
  one implementation).
- **web:** a `directory_picker.tsx` (fetch + navigate + pick), wired into the create form (replacing the
  free-text field, for both modes) and a "change directory" control on the session page (owner-only). Vitest +
  MSW for navigation, pick, and the escape/error fallback.
- **contract:** neutral — no new event types, envelope, or run status. If the session-create/`/api` surface is
  considered part of the frozen `http-api-contract`, the two new endpoints are an additive `CHANGELOG` note.
- **Consumes (does not modify):** `no-git-chat-mode` (`mode` + `repository_path`), `file-and-diff-api`
  (`RepoBrowser` containment), `session-create`.
- **Out of scope:** browsing outside the mounted repo root (the sidecar can only `cwd` into mounted paths);
  creating new directories from the UI; a full file-manager; changing a session's `mode` after creation.
