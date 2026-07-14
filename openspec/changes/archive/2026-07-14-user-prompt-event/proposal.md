## Why

The activity feed renders everything Claude does — `ai_text`, tools, terminal output, run lifecycle — but
**never shows the human's own words**. The prompt that started a run (and every mid-run follow-up) lives only
on `AiRun.prompt` and is pushed straight into the SDK; it is never emitted as an event, so the event-sourced
feed cannot reconstruct it. A watcher who joins late sees Claude answering a question nobody can see. This
breaks the core "watch/guide Claude work live" promise: a session transcript should read as a conversation,
not a monologue.

## What Changes

- **New `user_prompt` event type** (the 21st taxonomy name) — a **run-scoped, durable** Contract-1 event
  carrying the human's prompt text, attributed to the requesting participant (`actor.kind: "user"`). Additive
  contract change: `CONTRACT_VERSION` minor bump `1.1 → 1.2`, a `docs/contracts/CHANGELOG.md` entry, and the
  `EVENT_TYPE_COUNT` freeze-guard updated `20 → 21`. The envelope, scalar field types, and `Actor` union are
  untouched — only the taxonomy grows by one additive name.
- **The sidecar emits it** — the sidecar (which already holds the prompt + follow-up text and **owns the
  per-run `seq` space**) emits `user_prompt` immediately before pushing each user message into the SDK's
  streaming-input iterable: once for the initial prompt and once per follow-up (`sendMessage`). The normalizer
  stays the only SDK-shape-aware file; the runner already has the text in hand at the push site.
- **The web feed renders it inline** — a new `feed/user_prompt_block.tsx`, switched on in `activity_feed.tsx`,
  rendered interleaved with Claude's output in correct `seq` order and visually distinguished from Claude's
  `ai_text` (attributed to the participant, light styling consistent with the run banner). Claude's reply
  already renders via `ai_text`; this closes the loop so user + AI both appear.

This change does **not** add a new HTTP endpoint, change the run-control flow, touch `chat_message` (chat stays
session-scoped and separate from run prompts), or alter the `seq`/idempotency rules — `user_prompt` rides the
existing `[ai_run_id, seq]` index and the sidecar→Rails ingest path exactly like every other run-scoped event.

## Capabilities

### New Capabilities
- `user-prompt-event`: the run-scoped, durable `user_prompt` Contract-1 event — its envelope rules
  (run-scoped `ai_run_id` + per-run `seq`, `actor.kind: "user"`, `payload.text`), the sidecar emit points
  (initial prompt + each follow-up, ordered before the corresponding SDK input), and the web feed rendering
  (inline, in `seq` order, attributed, distinct from `ai_text`).

### Modified Capabilities
<!-- None as OpenSpec deltas: the consumed capabilities (event-envelope / contracts-package from
     freeze-interface-contracts, sidecar-runner, activity-feed-rendering) are not archived into
     openspec/specs/, so there is no delta file to write. This change ADDS one taxonomy name and its
     producer/consumer behavior additively (a minor CONTRACT_VERSION bump per the frozen contract's own
     additive-change rule); it does not change any frozen requirement — the envelope, scalar types, Actor
     union, seq/idempotency invariants, and all endpoint signatures are preserved. -->

## Impact

- **Contract** (`packages/contracts/src/events.ts`): `+user_prompt` in `EVENT_TYPES`, a `UserPromptPayload`
  interface + `EventPayloadMap` entry, `CONTRACT_VERSION` → `{ major: 1, minor: 2 }`, `EVENT_TYPE_COUNT`
  guard `20 → 21`. Docs: `docs/contracts/events.md` (new row), `docs/contracts/sdk_mapping.md` (emit-point
  note — it is sidecar-originated, not SDK-message-derived), `docs/contracts/CHANGELOG.md` (additive entry).
- **Sidecar** (`sidecar/src/normalizer.ts`, `sidecar/src/runner.ts`): a normalizer method to build a
  `user_prompt` envelope (run-scoped, requester-attributed, next `seq`), emitted by the runner at both push
  sites (initial `startRun` prompt and each `sendMessage` follow-up). Vitest coverage in
  `sidecar/test/runner.test.ts` / `normalizer*.test.ts`.
- **Rails** (`api/`): none beyond consuming the new type — `Events::Ingest` already persists any run-scoped
  durable event verbatim by `(ai_run_id, seq)`; `Runs::Finalize` ignores non-lifecycle types. A factory/spec
  may assert ingest persists `user_prompt`.
- **Web** (`web/src/components/activity_feed.tsx`, new `web/src/components/feed/user_prompt_block.tsx`):
  render the new type inline; Vitest + RTL render test.
- **Version consumers**: the Rails `ContractVersion` check already tolerates a `minor` bump (exact `major`,
  `minor >=` needed) — proven across the `1.0 → 1.1` bump; this `1.2` bump exercises the same mechanism.
