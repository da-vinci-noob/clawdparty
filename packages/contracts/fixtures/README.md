# Fixtures — the executable contract

## `sample_run.jsonl`

A sequence of **post-normalization** Contract-1 event envelopes (one JSON object per line),
consumable by all three streams as the single executable contract:

- **web** renders it (the activity-feed reducer replays it),
- a **Rails** fake-Claude rake task replays it through *real* `Events::Ingest`,
- the **sidecar** normalizer tests assert producing it.

It contains **only normalized envelopes** — never raw SDK message shapes. (Raw SDK logs are a
separate fixture set, input to the normalizer tests, owned by the `sidecar/` stream.)

### ⚠️ Interim placeholder (pre-spike)

> This file is currently the **hand-authored, envelope-only placeholder** allowed by
> `freeze-interface-contracts` task **5.4** (the "if the Tuesday SDK spike slips" escape hatch).
> It exists to unblock the ingest/broadcast/backfill plumbing and the Week-1 replay milestone,
> which treat `payload` as opaque JSON.
>
> **Every `payload` here is `{}`** — payload field schemas are `pending-spike` (see
> [`docs/contracts/events.md §8`](../../../docs/contracts/events.md)). When the spike lands,
> **replace this file** with real spike-derived events carrying concrete payloads (task 5.1) and
> drop this warning.

### What the placeholder *does* exercise (and is verified to)

Although payloads are empty, the file is a faithful exercise of every **frozen** envelope rule,
and `fixtures/sample_run.test.ts` asserts all of them:

- durable events carry an integer `id`, ascending across the run; **ephemeral**
  (`ai_text_delta`, `presence_changed`) carry `id: null`;
- per-run `seq` is monotonic and is **not advanced by ephemeral events** (the `ai_text` after the
  two deltas takes the next `seq`, as if the deltas had not been emitted);
- session-scoped events carry `null` `ai_run_id`/`seq`; run-scoped events carry both;
- each event's `actor.kind` matches the frozen per-type table (e.g. `run_finished` → `system`,
  `run_interrupted`/`run_started` → `user`, `ai_text` → `claude`), and `actor.id` is present
  **iff** `kind === "user"`;
- `ts` is ISO-8601 UTC with millisecond precision and a `Z` suffix.
