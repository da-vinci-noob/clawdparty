## Context

clawdparty is built by three people in three streams (`api/`, `sidecar/`, `web/`) on a compressed 3-week timeline. The only way three streams move in parallel without constant coordination is to agree the **seams** between them up front and freeze them. `docs/PLAN.md §11` names three contracts and a hard sequencing rule: they freeze **Wednesday of Week 1, only after the Tuesday SDK spike**, because the event payloads derive from real `@anthropic-ai/claude-agent-sdk` message shapes nobody has seen yet — "schemas invented before the spike are fiction."

This change is unusual for OpenSpec: its deliverable is **interface documents + shared types**, not running behavior. The specs here therefore describe the *rules the frozen contract must satisfy* (envelope shape, idempotency, role matrix, governance), and `tasks.md` lists *producing the contract files* as the work. The contract docs live at `docs/contracts/` and the shared types at `packages/contracts/` — both are referenced (not duplicated) by the downstream `rails-foundation`, `sidecar-foundation`, and `web-scaffold` changes.

## Goals / Non-Goals

**Goals:**
- Freeze the **event envelope** and the 20 type names so all three streams switch/persist/emit on the same vocabulary.
- Freeze the **Rails↔sidecar protocol** (the A↔B seam) including the worktree convention and `base_sha` rule.
- Freeze the **REST + cable API** surface and the 4-role matrix, with the rule that all live state arrives as a Contract-1 event.
- Ship `packages/contracts` as the **shared TypeScript source of truth** plus `sample_run.jsonl` as the **executable contract**.
- Establish lightweight **governance**: a CHANGELOG and a change-classification rule that makes additive change cheap and envelope change loud.
- Draw an explicit **freeze-now vs spike-gated** line so work isn't blocked on the spike where it doesn't need to be.

**Non-Goals:**
- Implementing any endpoint, channel, normalizer, or reducer (those are downstream changes).
- Inventing per-type payload field schemas before the spike — they are explicitly deferred.
- Designing future-phase concerns (Tailscale, per-tool Bash gating, Vertex/Foundry auth modes).
- Capturing the raw SDK message fixtures (a separate set feeding normalizer tests, owned by `sidecar-foundation`).

## Decisions

**1. One envelope for everything live; no bespoke cable messages.**
Every live thing — text deltas, tool events, chat, presence, run lifecycle, changeset state — arrives as a single shape `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }`. *Why:* one reducer, one persistence path, one catch-up algorithm. Alternative (typed per-concern cable messages) was rejected because it multiplies the catch-up/dedup logic and breaks the "event stream alone reconstructs the UI" invariant.

**2. Two cursors: per-run monotonic `seq`, global `events.id`.** The sidecar assigns `seq` per run; Rails assigns the global autoincrement `id`. Clients page/backfill on `id`; ingest dedupes on `(ai_run_id, seq)`. *Why:* `seq` makes sidecar→Rails ingest idempotent under retries/replays (the partial unique index silently skips dupes); `id` is a single monotonic cursor across the whole session regardless of which run produced an event.

**3. Ephemeral vs durable, decided at the envelope layer.** `ai_text_delta` and `presence_changed` are **broadcast but never persisted** (deltas coalesced ~150ms in the sidecar); `ai_text` is the durable record on block stop. *Why:* a modest run can emit 10–20k deltas; persisting them would bloat the store and the backfill. The contract names which types are ephemeral so all three streams agree without rediscovering it.

**4. Capabilities are split four ways, mapping one-to-one to the deliverables.** `event-envelope`, `sidecar-protocol`, `http-api-contract`, `contracts-package`. *Why:* downstream changes cite a specific seam (e.g. `rails-foundation` references `event-envelope`'s idempotency requirement). A single lumped capability would force them to reference a section rather than a named capability. Trade-off: four small specs instead of one, which is the intended granularity.

**5. Freeze-now vs spike-gated boundary, stated in the contract itself.** Frozen now: the envelope fields, the 20 type *names*, all endpoint signatures, the worktree convention, the role matrix. Deferred to Wednesday (post-spike): per-type **payload** field schemas, the concrete `events.ts` payload interfaces, and `sample_run.jsonl`. *Why:* ~70% of the contract (and the entire Week-1 replay milestone, which only exercises the envelope) is shape-agnostic and must not wait on the spike. The milestone "replay the fixture end-to-end" treats `payload` as opaque JSON, so ingest/broadcast/backfill can be built before payloads are final.

**6. `sample_run.jsonl` is post-normalization contract events, not raw SDK.** It is the executable contract: `web` renders it, a Rails fake-Claude rake task replays it through real ingest, and the sidecar normalizer asserts it produces it. The *raw* SDK logs are a separate fixture set (input to normalizer tests), owned by `sidecar-foundation`. *Why:* conflating the two is the most likely source of confusion; the contract package holds only the normalized output.

**7. Compose-network addressing, not a hard-coded host.** The protocol doc specifies Rails reaches the sidecar via `SIDECAR_URL` (default `http://sidecar:8787` over the Docker compose network), and the sidecar→Rails callback is similarly configurable. *Why:* keeps Tailscale/remote a future drop-in and matches the Docker-Compose runtime decision; nothing in the app assumes a fixed host.

**8. Governance: additive cheap, envelope loud.** Post-freeze: new event *types* are additive and only need a CHANGELOG entry; changes to the *envelope* or to a frozen endpoint signature are breaking — recorded as a breaking CHANGELOG entry and treated as emergencies. *Why:* the envelope is the single load-bearing shape; everything tolerates new types but nothing tolerates a shifted envelope mid-build.

**9. The fake-Claude rake task calls `Events::Ingest` directly; the HTTP wire contract is covered by a separate request spec.** The replay tool invokes the ingestion service in-process rather than POSTing to `/internal/events`. *Why:* a seed/replay tool should not depend on a running Puma + a valid `SIDECAR_SHARED_SECRET` just to populate a session — direct call is simpler, faster, deterministic, and server-independent, while still being genuinely real ingest. "Real" splits into two seams: the **ingestion core** (persist, dedupe on `(ai_run_id, seq)`, ephemeral-skip, broadcast) — which a direct call exercises *identically* to production — and the **wire contract** (bearer auth, batch-envelope parsing, `409`/`401`) — which the direct call skips. The W1 milestone ("replay end-to-end, watchable from multiple browsers") only needs the ingestion core. Alternative (POST to `/internal/events`) was rejected for the rake task because it couples seeding to the HTTP boundary for no milestone benefit. **Two architectural constraints make "direct == real" actually hold, and both carry forward into `rails-foundation`:** (a) `/internal/events` must be a *thin* controller — `auth → parse batch → Events::Ingest.call(each) → render`, with zero ingestion logic of its own; (b) **broadcast must live inside the `Events::Ingest` path, not the controller** — otherwise a direct replay persists but does not broadcast, and a watching browser sees nothing, failing the "watchable" milestone. The wire contract is verified separately by a focused `/internal/events` request spec (auth rejection, batch shape, `409`), which `docs/PLAN.md §13` already lists as a must-test ("ingest secret").

**10. `actor` is a discriminated union on `kind`, carrying a participant `id` (not a name) for human-originated events.** The shape is `{ kind: "claude" } | { kind: "user"; id: string } | { kind: "system" }`. *Why:* attribution is a cross-cutting envelope concern, not a per-payload one — human-originated events (`chat_message`, `participant_joined`, `presence_changed`, `run_started`, `changeset_approved`, …) must render *which* participant acted, while Claude/system events have no identity. A flat enum (`"claude" | "user" | "system"`) cannot carry the id, forcing `participant_id` to be stuffed into payloads inconsistently per type — which defeats the envelope's reason for existing (one uniform shape the reducer attributes the same way). A loose `{ kind, id? }` makes illegal states representable (`claude` with an id, `user` without one); the discriminated union makes `id` **required exactly when `kind === "user"` and absent otherwise**, so TypeScript enforces the invariant. Deliberate boundary: `actor` carries the **id**, not the display name (names are mutable and the participant→name map already lives client-side), and not the `role` (resolved from the participant and enforced server-side regardless of what an event claims).

## Risks / Trade-offs

- **Spike slips → freeze slips.** If the Tuesday spike can't map SDK messages to the draft taxonomy by Wednesday → mitigation: the envelope/names/endpoints freeze regardless, downstream builds against opaque payloads, and per-`docs/PLAN.md §14` the *payload* freeze slips up to 2 days without blocking the milestone. A hand-authored envelope-only `sample_run.jsonl` unblocks ingest plumbing in the interim.
- **Type-name churn at the Monday review.** The taxonomy is challenged Monday; a rename ripples into every stream → mitigation: downstream specs reference the `event-envelope` capability for the authoritative list rather than re-listing names, so a rename changes one place. The freeze (Wed, post-review) is the point names become immutable.
- **Payload under-specification invites drift.** Leaving payloads TBD risks two streams guessing differently → mitigation: the contract marks each type's payload as `pending-spike` explicitly (not silently absent), and `sample_run.jsonl` becomes the tie-breaker the moment it exists.
- **Contract-as-doc can rot vs. the TS types.** Two sources (`docs/contracts/*.md` and `packages/contracts/src/events.ts`) can diverge → mitigation: `events.ts` is the machine-checked source of truth for shapes; the `.md` carries prose/rationale and points at the types. CHANGELOG entries are required for both.
- **Over-freezing slows iteration.** Freezing too much too early → mitigation: the additive-types escape hatch keeps the common case (new event type) friction-free; only the envelope is hard-frozen.

## Resolved (previously open)

- **Replay transport for the fake-Claude rake task** → Decision 9: direct `Events::Ingest` call; HTTP wire contract covered by a separate `/internal/events` request spec. Carries two constraints into `rails-foundation` (thin controller; broadcast-in-service).
- **`actor` shape** → Decision 10: discriminated union `{ kind: "claude" } | { kind: "user"; id } | { kind: "system" }`; id (not name) for human events.
- **`seq` reset semantics on revise/resume** → Frozen in the `event-envelope` capability: `seq` is scoped per `ai_run_id` and restarts for a revised run that resumes a prior Claude session under a new `ai_run_id`; the sidecar does not carry `seq` across runs (the index is `(ai_run_id, seq)`).

## Open Questions

- None outstanding.
