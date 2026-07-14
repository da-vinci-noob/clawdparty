## ADDED Requirements

### Requirement: Chat send appends a chat_message via Events::Append

A Rails chat-send endpoint (`POST /api/sessions/:id/messages` or equivalent under `/api`) SHALL create the
message and append a `chat_message` event in one transaction via `Events::Append` (which broadcasts it), so chat
rides the same store/dedupe/broadcast path as every other event — no bespoke chat cable message. The endpoint
SHALL be `SessionPolicy`-gated to the `chat` action (permitted to all four roles). The `chat_message` event is
session-scoped (null `ai_run_id`/`seq`) and `user`-attributed to the sending participant.

#### Scenario: Sending chat appends and broadcasts a chat_message event

- **WHEN** a participant sends a chat message
- **THEN** the endpoint creates the message and appends a `chat_message` event in one transaction via
  `Events::Append`, which broadcasts it as a Contract-1 envelope

#### Scenario: All roles may chat

- **WHEN** any participant (owner/editor/reviewer/viewer) sends a chat message
- **THEN** `SessionPolicy` permits it (the `chat` action is allowed for all roles)

#### Scenario: Chat is an event, not a bespoke message

- **WHEN** chat is delivered to subscribers
- **THEN** it arrives as a `chat_message` Contract-1 event, not a custom cable message shape

### Requirement: Chat panel renders the chat stream from the store, with backfill for late joiners

The chat panel SHALL render the `chat_message` events from the `web-cable-client` store (deduped by `id` like
any durable event). Because chat is durable and backfilled by the same catch-up sequence, a participant joining
mid-session SHALL see prior chat.

#### Scenario: Chat renders from the store

- **WHEN** `chat_message` events are in the store
- **THEN** the chat panel renders them in order, deduped by `id`

#### Scenario: Late joiner sees prior chat

- **WHEN** a participant joins mid-session
- **THEN** the chat panel shows prior chat, because chat is durable and backfilled by the `web-cable-client`
  catch-up

### Requirement: Participant list and presence stub render from the store

The right sidebar SHALL render a participant list from `participant_joined` events, with a minimal online/offline
indicator driven by the last-writer-wins `presence_changed` map in the store. Full presence (typing indicators,
granular status) is out of scope; the stub list is sufficient for the Week-2 milestone.

#### Scenario: Participant list reflects joins and presence

- **WHEN** participants join and presence changes
- **THEN** the participant list shows joined participants with a minimal online/offline indicator from the
  last-writer-wins `presence_changed` state
