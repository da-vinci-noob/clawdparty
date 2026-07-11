# SDK → Contract-1 mapping (derived from the spike)

> **Status: derived from the real Tuesday-equivalent SDK spike** (`sdk-message-spike`). The raw input lives at
> `sidecar/test/fixtures/raw_run.jsonl` (captured from `@anthropic-ai/claude-agent-sdk@0.3.195` `query()` against
> a throwaway repo over Bedrock); the post-normalization output is
> `packages/contracts/fixtures/sample_run.jsonl`. This doc is the **single source** for how `normalizer.ts`
> (`sidecar-runner`) maps each raw SDK message to a Contract-1 envelope. It finalizes the payload schemas that
> were `pending-spike` in `events.md §8` — an **additive** `CONTRACT_VERSION` minor bump (`1.0 → 1.1`).

## Raw SDK message types observed in the spike

The spike's `SDKMessage` stream yielded these top-level `type`s (a representative run: text + thinking + a
file-edit tool + a Bash command + completion):

| raw `type` | `subtype` | content blocks | → Contract-1 type(s) |
|---|---|---|---|
| `system` | `init` | — | `run_started` (run open) |
| `assistant` | — | `text` | `ai_text` (durable, on block stop) + `ai_text_delta` (ephemeral, streaming) |
| `assistant` | — | `thinking` | `ai_thinking` |
| `assistant` | — | `tool_use` | `tool_started` |
| `user` | — | `tool_result` | `tool_finished` (ok) / `tool_failed` (`is_error: true`); `terminal_output` for Bash |
| `system` | `notification` | — | `ai_raw` (informational; not a taxonomy event) |
| `result` | `success`/`error` | — | `run_finished` (success) / `run_failed` (error), carrying cost + usage |

A `tool_use` whose `name` is `Write`/`Edit` also produces a `file_changed` event (file mutated in the worktree);
a `tool_use` whose `name` is `Bash` produces `terminal_output` events from its `tool_result` content (chunked).
Any raw message type NOT in this table degrades to `ai_raw` (never dropped, never a crash).

## Per-type payload schemas (the finalized contract)

All envelope fields (`id`/`session_id`/`ai_run_id`/`seq`/`type`/`actor`/`ts`) are per the frozen
`event-envelope`; below is each type's `payload`.

### `run_started` — from `system`/`init`
```jsonc
{ "model": string, "cwd": string, "permission_mode": string, "claude_session_id": string }
```
`claude_session_id` ← the SDK `session_id`. `actor` is `{ kind: "user", id: <requested_by> }` (stamped by the
runner, not from the SDK message).

### `user_prompt` — NOT an SDK message (synthesized by the runner; added v1.2)
```jsonc
{ "text": string }
```
The human's prompt that drives the run. There is **no raw SDK message** for this — the sidecar synthesizes a
`user_prompt` envelope immediately **before** it pushes each user message into the SDK streaming-input iterable:
once for the initial prompt (`runner.startRun`) and once per follow-up (`runner.sendMessage`). Run-scoped +
durable; `actor` is `{ kind: "user", id: <requested_by> }`; `seq` is the next per-run monotonic value (so on a
fresh run the prompt is `seq 1` and `run_started` is `seq 2`). Added additively at `CONTRACT_VERSION` 1.2
(`user-prompt-event`); see `CHANGELOG.md [1.2.0]`.

### Live streaming — `ai_text_delta` / `ai_thinking_delta` (added v1.3)

Enabled by `includePartialMessages: true` + `thinking: { type: "adaptive" }` in the run options. The SDK then
interleaves `SDKPartialAssistantMessage` (`type: "stream_event"`, `event: BetaRawMessageStreamEvent`) with the
complete messages. The runner maps only `event.type === "content_block_delta"`, and reads `message.id` off
`event.type === "message_start"`:

- `event.type === "message_start"` → latch the turn's stable id (`event.message.id`); emits nothing
- `delta.type === "text_delta"` (`delta.text`) → **`ai_text_delta`**
- `delta.type === "thinking_delta"` (`delta.thinking`) → **`ai_thinking_delta`**

The other stream-event subtypes (`message_start` also `stop`, `content_block_start`/`stop`, `message_delta`) emit
no event (no `ai_raw`).

**Block key = `"<message.id>:<block_type>"`** (`block_type` ∈ `text` \| `thinking`). The key is NOT built from the
top-level `uuid`: the real SDK gives **every** streamed message and delta a **unique** top-level `uuid`, and it
splits one assistant turn across several messages that share `message.id` but each carry a different `uuid`
(see `sidecar/test/fixtures/raw_run.jsonl:2-4` — three messages, one `message.id`, three `uuid`s). Keying by
`uuid` therefore fragments every delta into its own block and orphans the durable-block reconstruction. The
stable per-turn id is `message.id` (carried on `message_start`; the `content_block_delta`s do NOT carry it — the
normalizer latches it as `currentMessageId`); within a message, a `thinking` and a `text` block are told apart by
type. So all of a turn's text deltas share `"<message.id>:text"`, all its thinking deltas share
`"<message.id>:thinking"`, and the durable `ai_text`/`ai_thinking` reuse those exact keys to settle the block.

### `ai_text_delta` — ephemeral, from `content_block_delta` `text_delta`
```jsonc
{ "block": string, "text": string }
```
`block` = `"<message.id>:text"` (the key the web reducer accumulates by). Ephemeral: null `id`, null `seq`.

### `ai_thinking_delta` — ephemeral, from `content_block_delta` `thinking_delta`
```jsonc
{ "block": string, "text": string }
```
`block` = `"<message.id>:thinking"`; `text` carries the `delta.thinking` chunk. Ephemeral: null `id`/`seq`.

### `ai_text` — durable, from a completed `text` block
```jsonc
{ "block": string, "text": string }
```
Emitted on text-block stop; `block` matches the deltas that preceded it.

### `ai_thinking` — durable, from a completed `thinking` block
```jsonc
{ "text": string }
```
The `signature` field on the raw thinking block is dropped (internal; not rendered). `ai_thinking_delta`s
stream the same content live before this settles.

### `tool_started` — from a `tool_use` block
```jsonc
{ "tool_use_id": string, "name": string, "input_summary": string }
```
`input_summary` is the **summarized** tool input — path/command form, **≤ ~500 chars**, NEVER the full
Edit/Write content (the raw `input` carries the whole file; it MUST NOT be passed through). Summary rules:
`Write`/`Edit` → the `file_path`; `Bash` → the `command` (+ `description` if present); `Read` → the `file_path`;
other → a `≤500`-char JSON-stringified-and-truncated form.

### `tool_finished` — from a `tool_result` with `is_error` falsy
```jsonc
{ "tool_use_id": string, "ok": true }
```

### `tool_failed` — from a `tool_result` with `is_error: true`
```jsonc
{ "tool_use_id": string, "ok": false, "error": string }
```
`error` is the tool_result content, redact-then-truncate-bounded (8KB) like `ai_raw`.

### `terminal_output` — from a Bash `tool_result`'s content
```jsonc
{ "tool_use_id": string, "chunk_index": integer, "text": string }
```
Bash output is emitted in **~64KB chunks** (one event per chunk, `chunk_index` ascending), never one unbounded
blob.

### `file_changed` — from a `Write`/`Edit` `tool_use`
```jsonc
{ "tool_use_id": string, "path": string, "change": "created" | "modified" }
```
The full diff is NOT in the event — it is fetched via `GET /api/runs/:id/diff` (REST-only). `change` is
`created` for `Write` of a new path, `modified` otherwise.

### `run_finished` — from `result`/`success`
```jsonc
{ "stop_reason": string, "num_turns": integer, "duration_ms": integer,
  "total_cost_usd": number, "usage": { "input_tokens": integer, "output_tokens": integer,
  "cache_creation_input_tokens": integer, "cache_read_input_tokens": integer } }
```
`actor` is `{ kind: "system" }`. `usage` is the trimmed token breakdown from the SDK `usage` dict (the SDK's
extra fields — `server_tool_use`, `service_tier`, `inference_geo`, `iterations`, `speed`, `cache_creation` — are
dropped; only the four token counts are carried).

### `run_failed` — from `result`/`error` (or an API-error result)
```jsonc
{ "stop_reason": string, "api_error_status": string | null, "total_cost_usd": number, "usage": {...} }
```
`actor` is `{ kind: "system" }`.

### `run_interrupted` — from the interrupt path (not a raw SDK message)
```jsonc
{}
```
Emitted by the runner on `POST /runs/:id/interrupt`; `actor` is `{ kind: "user", id: <requested_by> }`.

### `ai_raw` — fallback for any unmapped/malformed/informational message (e.g. `system`/`notification`)
```jsonc
{ "raw": <redacted, ≤8KB>, "truncated": boolean }
```
Redact-credentials-FIRST-then-truncate (8KB), per `sidecar-normalizer-v1`.

## Notes carried into the implementation (`sidecar-runner`)

- The raw `tool_use.input` carries full content (the spike's `Write` included the whole file body) — confirming
  the **summarization obligation**: `input_summary`, never `input`.
- `total_cost_usd` and the token `usage` are on the `result` message → `run_finished`, per the PLAN obligation.
- `block` = `"<message.id>:<block_type>"` — the resolved accumulation key. NOT the top-level `uuid` (which is
  per-emission-unique and splits a single turn across messages that share one `message.id`).
- `changeset_ready`/`changeset_approved`/`changeset_rejected`/`task_*`/`participant_joined`/`presence_changed`/
  `chat_message` have NO SDK producer — they originate in Rails (`Events::Append`) or W3, not the normalizer.
