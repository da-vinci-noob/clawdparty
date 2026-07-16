# Contracts CHANGELOG

The frozen interface contracts ([`events.md`](./events.md),
[`sidecar_protocol.md`](./sidecar_protocol.md), [`http_api.md`](./http_api.md)) and the shared
types ([`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts)) are the
seams that let the `api/`, `sidecar/`, and `web/` streams build independently. **Once frozen,
nothing changes silently — every change is an entry here.**

## Governance — additive is cheap, the envelope is loud

| change | classification | what it requires | version |
|---|---|---|---|
| Add a new **event type** | additive | a CHANGELOG entry; bump `CONTRACT_VERSION.minor` | `minor +1` |
| Add a new **optional field** to a payload | additive | a CHANGELOG entry; bump `minor` | `minor +1` |
| Finalize a `pending-spike` **payload** schema | additive | a CHANGELOG entry; bump `minor` | `minor +1` |
| Change the **envelope** shape (add/remove/rename a field, change a scalar type) | **breaking** | a **breaking** entry; treated as an **emergency**; bump `major` (reset `minor` to 0) | `major +1` |
| Change a frozen **endpoint signature** (path, method, request/response shape, status) | **breaking** | a **breaking** entry; emergency; bump `major` | `major +1` |
| Remove or rename an **event type** | **breaking** | a **breaking** entry; emergency; bump `major` | `major +1` |

`CONTRACT_VERSION` is `{ major, minor }` in `events.ts`. A consumer asserts compatibility by
requiring an **exact `major`** and a **`minor` ≥** what it needs — so a breaking `major` bump
fails the assertion rather than slipping through a loose `≥`, while an additive `minor` bump
stays compatible.

The freeze-now vs spike-gated boundary is documented in [`events.md §9`](./events.md). Replacing
a `pending-spike` payload marker with a concrete schema is **additive** (a `minor` bump), not
breaking — downstream code treated the payload as opaque and keeps working.

---

## [protocol] — selectable Claude permission mode (sidecar-protocol, additive)

**`CONTRACT_VERSION` unchanged at `{ major: 1, minor: 3 }`** — this touches the **sidecar protocol**
(`sidecar_protocol.md`), not the event taxonomy/envelope/payloads, so the event contract version does
not move. Change: `claude-permission-modes`.

### Added / widened (additive — nothing removed or renamed)

- **`permission_mode` on `POST /runs`** is now a **selectable allowlist** value — `plan` / `acceptEdits`
  (the default when omitted, i.e. the prior fixed behavior) / `bypassPermissions` — rather than the fixed
  literal `acceptEdits`. Omitting the field is unchanged behavior, so existing callers are unaffected.
  `bypassPermissions` is **owner-only** (Rails-enforced) because the SDK does not constrain it by
  `allowed_tools`. Values outside the allowlist are rejected by Rails (`422`).
- **New endpoint `POST /runs/:id/permission_mode`** (`{ permission_mode, requested_by }` → `200
  { run_id, permission_mode }`; `404` unknown; `409` not active) — switches the active run's mode
  in-session (plan→execute). Adding an endpoint is additive; no existing endpoint signature changed.

### Unchanged (why this is not a `major`)

The event envelope, the 22-name taxonomy, all payloads (`run_started` already carried `permission_mode`),
the `(ai_run_id, seq)` rules, and every **existing** endpoint signature are untouched. `cwd` stays pinned
to the worktree in all modes; `canUseTool` stays allow-all (per-tool live approval remains out of scope).

## [1.3.0] — `ai_thinking_delta` event, live streaming (additive)

**`CONTRACT_VERSION = { major: 1, minor: 3 }`.** Additive `minor` bump (`live-streaming-thinking`): a new
**ephemeral** event type so Claude's thinking can stream live, matching how `ai_text_delta` already streams
text. Live streaming was designed but unwired (the runner never enabled partial messages); this finishes it.

### Added (additive — nothing removed or changed)

- **`ai_thinking_delta` event type** (the 22nd taxonomy name) — **ephemeral** (broadcast, never persisted;
  null `id`/`seq`), payload `AiThinkingDeltaPayload { block, text }` mirroring `ai_text_delta`. Keyed by the
  same `"<uuid>:<index>"` block key as the durable `ai_thinking`, so the live accumulator reconciles with the
  settled block. Registered ephemeral in the sidecar normalizer and Rails `Event` (alongside `ai_text_delta`
  and `presence_changed`).
- **`EVENT_TYPE_COUNT`** freeze guard updated `21 → 22`.
- **Sidecar streaming** (behavior, not contract): the runner enables `includePartialMessages` + adaptive
  thinking and maps `content_block_delta` `text_delta` → `ai_text_delta` and `thinking_delta` →
  `ai_thinking_delta` (see `sdk_mapping.md`).

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the `Actor` union, `ai_text_delta` and every other type, the
`(ai_run_id, seq)` idempotency + dual-cursor rules, and every endpoint/protocol signature are **unchanged**.
`ai_thinking_delta` is ephemeral like `ai_text_delta` (null `id`/`seq`, broadcast-not-persisted) so it needs
no persistence changes. A consumer requiring exact `major` and `minor ≥ 1` stays compatible.

## [1.2.0] — `user_prompt` event (additive)

**`CONTRACT_VERSION = { major: 1, minor: 2 }`.** Additive `minor` bump (`user-prompt-event`): a new
event type so the activity feed can show the human's words, not just Claude's. The feed is rebuilt
from the event stream alone; the prompt previously lived only on `AiRun.prompt` and was never an
event, so a watcher saw answers to invisible questions.

### Added (additive — nothing removed or changed)

- **`user_prompt` event type** (the 21st taxonomy name) — **run-scoped, durable**, `actor.kind: "user"`
  (the requesting participant), payload `UserPromptPayload { text }`. Carries the initial prompt and
  each mid-run follow-up.
- **Producer:** the **sidecar** emits it (it already holds the prompt text and **owns the per-run
  `seq` space** — Rails has no collision-free run `seq`). Emitted immediately **before** each user
  message is pushed into the SDK streaming-input iterable, so the prompt's `seq` precedes the output
  it triggers (on a fresh run: `user_prompt` = `seq 1`, `run_started` = `seq 2`).
- **`EVENT_TYPE_COUNT`** freeze guard updated `20 → 21`.

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the `Actor` union, the `(ai_run_id, seq)` idempotency + dual-cursor
rules, the ephemeral-vs-durable rule, and every endpoint signature are **unchanged**. `user_prompt`
rides the existing sidecar→Rails ingest path and the `[ai_run_id, seq]` index like any other run-scoped
durable event; Rails needs no new code (ingest persists it verbatim, `Runs::Finalize` ignores it). A
consumer requiring exact `major` and `minor ≥ 1` stays compatible (proven across `1.0 → 1.1`).

## [1.1.0] — SDK payload finalization (additive)

**`CONTRACT_VERSION = { major: 1, minor: 1 }`.** Additive `minor` bump (`sdk-message-spike`):
per-type `payload` schemas, previously `pending-spike`, are now finalized from real
`@anthropic-ai/claude-agent-sdk` `query()` output captured over Bedrock.

### Added (additive — nothing removed or changed)

- **Concrete per-type payload interfaces** in `packages/contracts/src/events.ts` (`EventPayloadMap`
  + one interface per type), replacing the `unknown` `PendingSpikePayload` stubs.
- **`docs/contracts/sdk_mapping.md`** — the single source mapping each raw SDK message shape →
  Contract-1 type + payload, derived from `sidecar/test/fixtures/raw_run.jsonl`.
- **Resolved `ai_text_delta` `block` field** — `"<assistant_message_uuid>:<content_block_index>"`.
- **Pinned PLAN payload obligations** — `total_cost_usd` + `usage` on `run_finished`/`run_failed`;
  `tool_started.input_summary` (≤~500 chars, never the full Edit/Write content); `terminal_output`
  ~64KB chunks.
- **Real `packages/contracts/fixtures/sample_run.jsonl`** — spike-derived envelopes with concrete
  payloads, replacing the v1.0 envelope-only placeholder. The frozen structural invariants are
  unchanged (the existing fixture test still passes; a non-empty-payload smoke check is added).

### Unchanged (why this is a `minor`, not a `major`)

The envelope fields + scalar types, the 20 type names + `ai_raw`, the per-type actor/durability/scope
axes, the `(ai_run_id, seq)` idempotency + dual-cursor rules, the ephemeral-vs-durable rule, the
`actor` union, and every endpoint signature are **unchanged**. A consumer requiring an exact `major`
and `minor ≥ 0` (e.g. the Rails `ContractVersion`/`FakeClaude::Replay` consumer) stays compatible.

## [1.0.0] — Week 1 freeze

**`CONTRACT_VERSION = { major: 1, minor: 0 }`.** Frozen at the Wednesday-of-Week-1 gate
(`docs/PLAN.md §11`); per-type payloads deferred as `pending-spike` (finalized additively at 1.1).

### Frozen now

- **Event envelope** — `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }` with pinned
  scalar types; `ts` is ISO-8601 UTC ms+`Z`, display-only.
- **Taxonomy** — exactly 20 type names + the `ai_raw` fallback; asserted at 20 in `events.ts`.
- **Per-type axes** — `actor.kind`, durable-vs-ephemeral, and run-vs-session scope for every type
  (the per-type table in `events.md §6`).
- **Cursors & idempotency** — per-run monotonic `seq`, global `id`; idempotent ingest on
  `(ai_run_id, seq)`; client dedupe-by-`id` for durable events.
- **Ephemeral rule** — `ai_text_delta` / `presence_changed` are broadcast-but-never-persisted,
  carry a null `id`, and never consume `seq`.
- **`actor`** — discriminated union `{ kind: "claude" } | { kind: "user"; id } | { kind: "system" }`.
- **Sidecar protocol** — all six endpoint signatures + success/error shapes; the worktree
  convention + `base_sha` rule; compose-network addressing (`SIDECAR_URL` /
  `RAILS_INTERNAL_URL`); bearer `SIDECAR_SHARED_SECRET` auth with constant-time compare.
- **HTTP + cable API** — REST surface; `/~cable` mount + one-envelope rule; the 4-role matrix;
  `403`-vs-`404` anti-enumeration rule; `clawd_uid` cookie auth; gap-free catch-up.
- **`packages/contracts`** — `events.ts` (envelope, taxonomy, `Actor`, `CONTRACT_VERSION`,
  compile-time freeze guards) + `fixtures/sample_run.jsonl` (the executable contract).

### Spike-gated (deferred — `pending-spike`)

- Per-type `payload` field schemas in `events.md` and concrete payload interfaces in `events.ts`
  (currently `unknown` stubs).
- The `ai_text_delta` `block` field representation.
- Real spike-derived `fixtures/sample_run.jsonl`. **Interim:** a hand-authored, envelope-only
  placeholder (`{}` payloads) stands in to unblock ingest plumbing — see
  `packages/contracts/fixtures/README.md`. Replacing it with real spike output will be an
  **additive** `minor` bump.
