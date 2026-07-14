> **Depends on `web-cable-client` (store) + `run-orchestration` (run-control endpoints).** Largely
> spike-independent (join/chat/presence/buttons are envelope/endpoint-level). May proceed in parallel with the
> spike; the activity feed it sits beside is the spike-gated part, not this change.

## 1. Join flow (session-join-ui)

- [x] 1.1 Replace the W1 `landing_page.tsx` placeholder with a real join form (invite token + display name)
- [x] 1.2 POST `/api/participants`; on success route to `/sessions/:id` with the returned participant; track joined-state from the response (do NOT read the httpOnly cookie)
- [x] 1.3 Surface `{ errors }` on `404` (invalid/expired/revoked) and `422` (blank name); stay on the join screen
- [x] 1.4 Tests: successful join routes in; refused join shows the error and does not route

## 2. Current-participant role hook (run-controls-ui)

- [x] 2.1 `use_current_participant` hook exposing the current participant's role for the session (from the join response / participants in the store)
- [x] 2.2 Confirm gating is presentation only — document that the server `SessionPolicy` is the authoritative gate

## 3. Prompt composer + interrupt (run-controls-ui)

- [x] 3.1 `prompt_composer.tsx`: start a run (`POST /api/sessions/:id/runs`) when none active; send a follow-up (`POST /api/runs/:id/messages`) when active; render only for owner/editor
- [x] 3.2 `interrupt_button.tsx`: `POST /api/runs/:id/interrupt`; render only for owner/editor and only while a run is active (active derived from store lifecycle events — `run_started` without a terminal event)
- [x] 3.3 Tests: composer/interrupt visible for owner/editor, hidden for reviewer/viewer; start vs follow-up chosen by active-run state

## 4. Chat send endpoint (chat-panel — Rails)

- [x] 4.1 Implement `POST /api/sessions/:id/messages`: create the `Message` + append a `chat_message` via `Events::Append` (one transaction, broadcasts); session-scoped, user-attributed to the sender
- [x] 4.2 `SessionPolicy`-gate to `chat` (all four roles); request spec: every role may chat; the event is a `chat_message` (not a bespoke message); appended atomically
- [x] 4.3 Confirm `api` suite stays green (`bin/rspec`)

## 5. Chat panel + presence (chat-panel — web)

- [x] 5.1 `chat_panel.tsx`: send via the chat endpoint; render `chat_message` events from the store (deduped by `id`); confirm a late joiner sees prior chat (backfilled)
- [x] 5.2 `participant_list.tsx`: render participants from `participant_joined` with a minimal online/offline indicator from the last-writer-wins `presence_changed` map
- [x] 5.3 Mount chat panel + participant list in the right sidebar region of the app shell
- [x] 5.4 Tests (MSW): chat send → store render round-trip; participant list reflects joins + presence

## 6. Validation

- [x] 6.1 Run `openspec validate prompt-composer-chat --type change --strict` and confirm valid
- [x] 6.2 Confirm `web` (Biome + tsc + Vitest) and `api` (RuboCop + RSpec) stay green
- [~] 6.3 Manual: two browser tabs join the same session; one (owner/editor) starts a run + interrupts; both see chat; the multi-browser/LAN cross-machine smoke (the W2 milestone) is exercisable  — *seam-verified live: join→cookie→chat (201, all roles), reviewer run-start correctly 403'd server-side, chat_message persisted+backfillable; the two-tab human click is the remaining step*
