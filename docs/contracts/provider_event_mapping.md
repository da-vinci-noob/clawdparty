# `ProviderEvent` → Contract-1 mapping

> **Machine-checked source of truth:** `harness/src/loop/normalize.ts` is the ONLY file
> that performs this mapping. This doc is authoritative for INTENT; that file is
> authoritative for behaviour. When they disagree, fix the drift and record it in
> [`CHANGELOG.md`](./CHANGELOG.md).

The harness owns the loop, so it defines its own provider-neutral event shape
(`ProviderEvent`) and each adapter maps its vendor's stream onto it. That makes this mapping **total by
construction** rather than defensive: the normalizer maps a shape the harness controls,
not whatever a vendor happens to emit.

The `ai_raw` safety valve is kept anyway. An adapter can still surface something
unrecognised via `{ t: "raw" }`, and a provider can add a block type tomorrow.

---

## Stream events

| `ProviderEvent` | → Contract-1 | Durability |
|---|---|---|
| `message_start` | — (no envelope; the turn id is minted by the loop) | — |
| `block_start` | — (records the block's kind for `block_stop`) | — |
| `text_delta` | `ai_text_delta` | **ephemeral** |
| `thinking_delta` | `ai_thinking_delta` | **ephemeral** |
| `tool_input_delta` | — (accumulated; a partial JSON tool input is not actionable) | — |
| `block_stop` (`text`) | `ai_text` | durable |
| `block_stop` (`thinking`) | `ai_thinking` | durable |
| `block_stop` (`tool_use`) | `tool_started` (+ `file_changed` when the call writes) | durable |
| `block_stop` (`compaction`) | `context_compacted` | durable |
| `message_delta` | — (usage rides `context_usage` + the ledger) | — |
| `message_stop` | — | — |
| `raw` | `ai_raw` | durable |

### Block keys

`block` is `"<turnId>:<index>"`.

`turnId` is **harness-minted**, not a vendor message id: it must be known before the
response arrives (the record needs the key) and it must survive a crash. A vendor id
satisfies neither.

The index matters. Keying by block *kind* instead collides when one turn emits two text
blocks, and the reducer then concatenates unrelated text under a single key — there is a
test for exactly that case in `harness/test/loop/behaviour_parity.test.ts`.

---

## Events the loop synthesizes

These map from **no provider event at all** — the harness emits them from its own state.
`SYNTHESIZED_EVENT_TYPES` in `events.ts` is the exported list.

| Contract-1 type | Emitted when |
|---|---|
| `user_prompt` | a prompt is recorded — the initial one, and each mid-run follow-up drained from the loop's inbox at a turn boundary |
| `request_header` | a request snapshot is **established or changed** — NOT per request; a reader folds the latest snapshot at or before any point |
| `context_usage` | each `message_delta`, against the model's real budget from `capabilities()`. **Ephemeral** |
| `tool_refused` | a `tool:before` handler refuses; carries who refused and why |
| `tool_finished` / `tool_failed` | a dispatched tool returns |
| `terminal_output` | a tool streams output, in ~64KB chunks keyed by `tool_use_id` |
| `provider_error` | a request fails; `remedy` is required and must be actionable |
| `recovery_applied` | recovery ran; `uncertain: true` when the outcome is genuinely unknowable |
| `run_finished` / `run_failed` / `run_interrupted` | the terminal transaction |

---

## Payload rules that are not obvious

**`blocks` are stored verbatim.** `payload` is the Contract-1 shape the UI renders;
`entries.blocks` is the untouched provider content-block array. Compaction returns a block
the next request needs unmodified, and a thinking block must be echoed back unedited or
the provider rejects it — so flattening to text breaks the conversation one turn later.

**`tool_started.input_summary` is capped at ~500 chars and is never the full input.** A
`create` carrying a whole file would otherwise put that file's contents into the feed and
into every projection of it.

**`ai_raw` redacts before truncating.** Truncating first can slice a secret in half and
leave its front in the record.

**`file_changed` follows the tool CALL, not the outcome.** A write that fails still
reports it. That is a known inaccuracy with a scheduled fix; it is confined
because `file_changed` is `on_surface: 0`, so it cannot corrupt request reconstruction,
and approve/reject reads git rather than events.
