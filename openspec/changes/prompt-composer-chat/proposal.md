## Why

`web-cable-client` + `activity-feed-rendering` make a run **watchable**, and `run-orchestration` +
`sidecar-runner` make runs **happen** — but nothing in the browser lets a human **drive** them yet. The
Week-2 milestone explicitly requires "owner can prompt and interrupt" and the chat sidebar
(`docs/PLAN.md §10`, Manish: "prompt composer + follow-up + interrupt button, role-gated, chat panel +
presence stub"; the five never-cut MVP pieces include session create/join, chat, and interrupt).

This change adds the **interactive half** of the session UI: the join flow (exchange an invite link for the
`clawd_uid` cookie), the prompt composer (start a run / send a follow-up), the interrupt button, the chat
panel, and a presence stub — all **role-gated on the client** (the server is the real gate; the client only
hides buttons, per the frozen role matrix). It depends on `run-orchestration` (the run-control endpoints it
calls) and `web-cable-client` (chat/presence arrive as Contract-1 events through the same store). Chat and
presence are envelope-level, so this change is **largely spike-independent**; only nothing here reads per-type
run payloads.

## What Changes

- **Join flow** — a landing/join screen that POSTs an invite token + display name to `POST /api/participants`,
  receives the signed httpOnly `clawd_uid` cookie, and routes into the session. This is what mints the cookie
  that authenticates both REST and cable (the `web-cable-client` connection assumes it exists; this change
  creates it).
- **Prompt composer** — start a run via `POST /api/sessions/:id/runs` and send a follow-up via
  `POST /api/runs/:id/messages`; shown only to owner/editor (server enforces; client hides for reviewer/viewer).
- **Interrupt button** — `POST /api/runs/:id/interrupt`, shown only to owner/editor, visible while a run is
  active (active state derived from run-lifecycle events in the store, not a bespoke message).
- **Chat panel** — the right sidebar: send a `chat_message` (everyone may chat, per the role matrix) and render
  the chat stream from the store (chat arrives as Contract-1 `chat_message` events via `Events::Append` +
  broadcast, deduped by `id` like any durable event). Sending posts to a chat endpoint that appends the event.
- **Presence stub** — render a participant list from `participant_joined` + the last-writer-wins
  `presence_changed` map already in the store (online/offline is a stub indicator; full presence is fine to
  keep minimal per the scope-cut ladder).
- **Client-side role gating** — read the current participant's role and hide controls the role can't use; this
  is presentation only, never the enforcement (server `SessionPolicy` is authoritative).
- **A chat send endpoint** in Rails (`POST /api/sessions/:id/messages` or equivalent) that appends a
  `chat_message` via `Events::Append` — the one small backend addition this change needs (chat is a never-cut
  MVP piece and has no W1/other-change home).
- **Vitest + RTL tests** for the composer/interrupt visibility-by-role and chat send/render (MSW for REST).

This change does **not** change the activity feed (it sits beside it), the diff/approval surface (W3), or the
run lifecycle (it calls the existing endpoints). Presence beyond the stub and rich composer affordances are
out.

## Capabilities

### New Capabilities
- `session-join-ui`: the landing/join screen exchanging an invite token + display name for the `clawd_uid`
  cookie via `POST /api/participants`, then routing into the session — the flow that mints the cookie the cable
  client and REST both authenticate with.
- `run-controls-ui`: the prompt composer (start run + follow-up), the interrupt button, and client-side
  role-gating (owner/editor only; server enforces), with active-run state derived from lifecycle events.
- `chat-panel`: the chat sidebar — sending a `chat_message` (everyone may chat) via a Rails chat endpoint that
  appends through `Events::Append`, rendering the chat stream and a participant/presence list from the
  `web-cable-client` store (`participant_joined` + last-writer-wins `presence_changed`).

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed changes (run-orchestration, web-cable-client, rails-foundation) are
     not archived into openspec/specs/. This ADDS UI + a chat endpoint on top of them without changing their
     requirements. -->

## Impact

- **New code (web):** `web/src/pages/landing_page.tsx` (real join, replacing the W1 placeholder),
  `web/src/components/prompt_composer.tsx`, `interrupt_button.tsx`, `chat_panel.tsx`, `participant_list.tsx`,
  a `use_current_participant`/role hook, and co-located `.test.tsx` tests.
- **New code (api):** a chat-send endpoint (`POST /api/sessions/:id/messages`) appending a `chat_message` via
  `Events::Append`, `SessionPolicy`-gated to `chat` (all roles), with a request spec.
- **Consumes (does not modify):** `run-orchestration` (`POST /sessions/:id/runs`, `/runs/:id/messages`,
  `/runs/:id/interrupt`), `rails-foundation` (`POST /api/participants` join → `clawd_uid` cookie, `Events::Append`,
  `SessionPolicy`, the `chat_message`/`participant_joined`/`presence_changed` events), and the `web-cable-client`
  store (chat/presence rendering).
- **Mostly spike-independent:** join, chat, presence, and the run-control *buttons* are envelope/endpoint-level.
  (The feed they sit beside is spike-gated, but this change does not render run payloads.) May proceed in
  parallel with the spike; depends on `run-orchestration` + `web-cable-client`.
- **Cross-stream:** with `activity-feed-rendering` this completes the W2 "watchable + owner can prompt and
  interrupt + chat" milestone; the join flow it adds is also what makes the multi-browser/LAN cross-machine
  smoke possible.
- **Dependencies:** `web-cable-client`, `run-orchestration`, `rails-foundation`, `freeze-interface-contracts`.
