# Fixtures — the executable contract

## `sample_run.jsonl`

A sequence of **post-normalization** Contract-1 event envelopes (one JSON object per line),
consumable by all three streams as the single executable contract:

- **web** renders it (the activity-feed reducer replays it),
- a **Rails** fake-Claude rake task replays it through *real* `Events::Ingest`,
- the **sidecar** normalizer tests assert producing it.

It contains **only normalized envelopes** — never raw SDK message shapes. (Raw SDK logs are a
separate fixture set, input to the normalizer tests, owned by the `sidecar/` stream.)

### Real spike-derived fixture (v1.1)

> As of `CONTRACT_VERSION` **1.1** (`sdk-message-spike`), this file is **real, spike-derived**
> output: it was produced by normalizing `sidecar/test/fixtures/raw_run.jsonl` — captured from a
> live `@anthropic-ai/claude-agent-sdk` `query()` over Bedrock against a throwaway repo — into
> Contract-1 envelopes with **concrete payloads** (real `total_cost_usd`, token `usage`, summarized
> tool inputs, resolved `block` keys). It replaces the v1.0 envelope-only placeholder (`payload: {}`).
> The per-type payload schemas it carries are documented in
> [`docs/contracts/sdk_mapping.md`](../../../docs/contracts/sdk_mapping.md) and typed in
> [`src/events.ts`](../src/events.ts) (`EventPayloadMap`).

### What the fixture exercises (and is verified to)

The file is a faithful exercise of every **frozen** envelope rule plus the v1.1 non-empty-payload
smoke check, and `fixtures/sample_run.test.ts` asserts all of them:

- durable events carry an integer `id`, ascending across the run; **ephemeral**
  (`ai_text_delta`, `presence_changed`) carry `id: null`;
- per-run `seq` is monotonic and is **not advanced by ephemeral events** (the `ai_text` after the
  two deltas takes the next `seq`, as if the deltas had not been emitted);
- session-scoped events carry `null` `ai_run_id`/`seq`; run-scoped events carry both;
- each event's `actor.kind` matches the frozen per-type table (e.g. `run_finished` → `system`,
  `run_interrupted`/`run_started` → `user`, `ai_text` → `claude`), and `actor.id` is present
  **iff** `kind === "user"`;
- `ts` is ISO-8601 UTC with millisecond precision and a `Z` suffix;
- durable events carry **non-empty** payloads (v1.1 smoke check; per-type field validation is the
  sidecar-runner normalizer cross-check against `raw_run.jsonl`).
