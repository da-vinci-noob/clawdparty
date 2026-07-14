## Context

This is the interactive half of the session UI. By the time it lands, `web-cable-client` provides the store +
live stream, `activity-feed-rendering` shows the run, and `run-orchestration` exposes the run-control endpoints
(`POST /api/sessions/:id/runs`, `/api/runs/:id/messages`, `/api/runs/:id/interrupt`, all `SessionPolicy`-gated to
owner+editor). `rails-foundation` already has the join endpoint (`POST /api/participants` → `clawd_uid` cookie),
`Events::Append`, `SessionPolicy`, and the `chat_message`/`participant_joined`/`presence_changed` events.

Two facts shape the design. First, the **cookie**: `web-cable-client` assumes a `clawd_uid` cookie already
exists; this change is what mints it (the join flow), closing that gap. Second, **the server is the gate**: the
frozen `http-api-contract` says the client only hides buttons; every action is enforced server-side by
`SessionPolicy`. So client role-gating here is presentation only.

Chat is a never-cut MVP piece (`docs/PLAN.md §12`) and has no home in W1 or the other W2 changes, so this change
includes the one small backend addition it needs: a chat-send endpoint that appends a `chat_message` via
`Events::Append` (which broadcasts it, so it rides the same store/dedupe path as everything else).

This change is largely spike-independent: join, chat, presence, and the run-control buttons are
envelope/endpoint-level; nothing here reads per-type run payloads.

## Goals / Non-Goals

**Goals:**
- Join flow: invite token + display name → `POST /api/participants` → `clawd_uid` cookie → route into session.
- Prompt composer: start a run + send follow-ups; visible to owner/editor only (client hides; server enforces).
- Interrupt button: visible to owner/editor while a run is active (active derived from lifecycle events).
- Chat panel: send `chat_message` (all roles) + render the chat stream from the store; a Rails chat-send
  endpoint appending via `Events::Append`.
- Presence stub: participant list from `participant_joined` + last-writer-wins `presence_changed`.
- Client role hook + visibility tests (per-role) + chat send/render tests (MSW).

**Non-Goals:**
- Server enforcement changes — `SessionPolicy` already gates everything; the client only hides.
- The activity feed (sits beside it — `activity-feed-rendering`), the diff/approval surface (W3).
- Rich presence (typing indicators, granular online/offline) — a stub list is enough (scope-cut ladder).
- Run lifecycle/orchestration — calls the existing endpoints, adds none.

## Decisions

**1. The join flow mints the cookie the rest of the app assumes.** The landing screen POSTs `{ token, name }` to
`POST /api/participants`; the server sets the signed httpOnly `clawd_uid` cookie and returns the participant; the
app routes to `/sessions/:id`. *Why:* `web-cable-client` and all REST calls authenticate with this cookie, and
W1 explicitly deferred the join UI; this closes the loop. The cookie is httpOnly, so JS never reads it — the app
tracks "joined" via the successful response + the returned participant, not by reading the cookie.

**2. Client role-gating is presentation only; the server is authoritative.** A `use_current_participant` hook
exposes the current participant's role for the session; the composer/interrupt controls render only for
owner/editor, chat renders for all. Even if a hidden control were invoked, the server denies it (`403`). *Why:*
frozen `http-api-contract` ("server enforces roles; the client only hides buttons"); duplicating enforcement in
the client would be both redundant and untrustworthy.

**3. Active-run state is derived from lifecycle events, not a bespoke message.** The interrupt button shows when
the store indicates an active run (a `run_started` without a terminal lifecycle event for that `ai_run_id`).
*Why:* the frozen rule that everything live is a Contract-1 event; run status is already in the store.

**4. Chat sends through a thin Rails endpoint that appends via `Events::Append`.** `POST /api/sessions/:id/messages`
creates the `Message` + appends a `chat_message` event in one transaction (via `Events::Append`), which
broadcasts it; the browser renders chat from the store like any durable event (deduped by `id`). *Why:* keeps
the "every mutation appends an event atomically" invariant and reuses the broadcast/store/dedupe path — chat is
not a special case. `SessionPolicy` gates it to `chat` (all four roles). *Alternative rejected:* a bespoke chat
cable message — violates the one-envelope rule.

**5. Chat and presence render from the same store as the feed.** `chat_message` (durable) and
`participant_joined` (durable) accumulate in the store; `presence_changed` (ephemeral, last-writer-wins) drives
the online/offline stub. The chat panel and participant list are selectors over that store. *Why:* one store,
one dedupe path; chat catch-up is the same backfill/drain as everything else (a late joiner sees prior chat).

**6. Presence is a stub.** The participant list shows who has joined (`participant_joined`) with a minimal
online/offline indicator from `presence_changed`. Full presence (typing, granular status) is out per the
scope-cut ladder. *Why:* the milestone needs "chat panel + presence stub," not a full presence system; keeping
it minimal protects the timeline.

**7. Tests assert visibility-by-role and chat round-trip with MSW; no live server.** RTL tests render the
composer/interrupt/chat with a stubbed current-participant role and assert owner/editor see the composer while
reviewer/viewer do not; a chat test posts via an MSW-stubbed endpoint and asserts the optimistic/store render.
*Why:* `docs/PLAN.md §13` frontend test scope; MSW `setupServer` is already wired.

## Risks / Trade-offs

- **Treating client role-gating as security.** It is not. *Mitigation:* server `SessionPolicy` is the gate
  (already built + spec'd in `run-orchestration`/`rails-foundation`); the client hook is presentation only, and
  a test confirms a hidden action still `403`s server-side (cross-referenced, enforced there).
- **httpOnly cookie can't be read by JS to know "am I joined."** *Mitigation:* track joined-state from the join
  response + a `whoami`-style derive (participant returned on join); never attempt to read the cookie.
- **Chat as events means chat shares the run event log.** *Mitigation:* that is intended (session-scoped events,
  null `ai_run_id`); selectors split chat from run activity for rendering; dedupe-by-`id` keeps it clean.
- **Active-run detection edge cases (missed terminal event).** *Mitigation:* derive from the store and reconcile
  on backfill/reconnect (the `web-cable-client` catch-up reruns), so a missed event self-heals on resync.
- **Late joiner missing prior chat.** *Mitigation:* chat is durable and backfilled by the same
  `web-cable-client` catch-up, so a mid-session joiner sees prior chat.

## Open Questions

- Whether the chat-send endpoint lives at `POST /api/sessions/:id/messages` vs a nested `chat_messages` route is
  a naming detail; it appends a `chat_message` via `Events::Append` either way, `SessionPolicy`-gated to `chat`.
