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

## [1.0.0] — Week 1 freeze

**`CONTRACT_VERSION = { major: 1, minor: 0 }`.** Frozen at the Wednesday-of-Week-1 gate
(`docs/PLAN.md §11`), after the Tuesday SDK spike.

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
