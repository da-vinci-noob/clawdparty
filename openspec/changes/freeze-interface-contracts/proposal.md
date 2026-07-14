## Why

The three code streams (`api/` Rails, `sidecar/` Node, `web/` React) must build independently against stable seams — but those seams don't exist yet. This is the **Wednesday-of-Week-1 gate** (`docs/PLAN.md §11`): freezing the event taxonomy + envelope, the Rails↔sidecar protocol, and the REST+cable API is what lets all three streams proceed without blocking each other. The freeze happens only **after** the Tuesday SDK spike — schemas invented before seeing real SDK output are fiction — so this change finalizes the envelope/names/endpoints now and fills spike-dependent payload internals once the spike output is in.

## What Changes

- Create `docs/contracts/events.md` — the event **envelope** `{id, session_id, ai_run_id, seq, type, actor, ts, payload}` and the 20 event type names, with the ephemeral-vs-durable rule. Envelope + names are frozen now; per-type **payload internals are marked TBD-spike** and finalized Wednesday.
- Create `docs/contracts/sidecar_protocol.md` — the Rails↔sidecar (A↔B) seam: `POST /runs`, `/runs/:id/messages`, `/runs/:id/interrupt`, `GET /healthz`, `POST /internal/events`, `POST /internal/sidecar/heartbeat`; the worktree convention (Rails creates it; path/branch layout; `base_sha` recorded at run start); compose-network addressing (`SIDECAR_URL`, default `http://sidecar:8787`); bearer auth with `SIDECAR_SHARED_SECRET`.
- Create `docs/contracts/http_api.md` — the REST endpoint list, the ActionCable mount (`/~cable`) + subscription shape, the 4-role matrix (owner/editor/reviewer/viewer), and the rule **everything live arrives as a Contract-1 event — no bespoke cable messages**.
- Create `docs/contracts/CHANGELOG.md` — seeded with the v1 freeze entry; the place all post-freeze changes are recorded.
- Create `packages/contracts/` — the shared TS package: `src/events.ts` (envelope type + type-name union; per-type payload interfaces stubbed until spike), package scaffolding (`package.json`, `tsconfig`, Biome), and `fixtures/sample_run.jsonl` — the **executable contract** (post-normalization contract events captured from the real Tuesday spike).
- Establish the **freeze process**: once frozen, additive event types need only a CHANGELOG entry, while envelope or endpoint changes are breaking and treated as emergencies.

This change produces interface documents and shared types — not running behavior. Downstream changes (`rails-foundation`, `sidecar-foundation`, `web-scaffold`) reference these capabilities rather than re-deriving them.

## Capabilities

### New Capabilities
- `event-envelope`: The canonical event envelope shape, the 20-type-name taxonomy, per-run monotonic `seq` + global `id` cursor semantics, idempotency on `(ai_run_id, seq)`, and the ephemeral-vs-durable rule (`ai_text_delta`/`presence_changed` broadcast-but-never-persisted).
- `sidecar-protocol`: The Rails↔sidecar HTTP contract — request/response shapes for every endpoint in both directions, the worktree convention and `base_sha` rule, compose-network addressing, and shared-secret auth.
- `http-api-contract`: The client-facing contract — REST endpoint list, cable mount + subscription/auth shape, the 4-role permission matrix, and the "all live state is a Contract-1 event" rule.
- `contracts-package`: The shared TypeScript types package and the `sample_run.jsonl` executable fixture, including the freeze/changelog governance process and the freeze-now-vs-spike-gated boundary.

### Modified Capabilities
<!-- None — this is a greenfield repo with no existing specs. -->

## Impact

- **New files:** `docs/contracts/{events,sidecar_protocol,http_api,CHANGELOG}.md`; `packages/contracts/` (`package.json`, `tsconfig.json`, `biome.json` or shared config, `src/events.ts`, `fixtures/sample_run.jsonl`).
- **Cross-stream:** this is the seam all three streams build against — `rails-foundation` (Events::Ingest, channels, controllers, SessionPolicy), `sidecar-foundation` (normalizer output, transport payloads), and `web-scaffold` (event reducer types) all consume it.
- **Sequencing dependency:** envelope/names/endpoints/role-matrix freeze immediately; per-type payload schemas + `sample_run.jsonl` are produced from the Tuesday SDK spike and finalized at the Wednesday freeze. If the spike can't map messages to the draft taxonomy by Wednesday, the freeze slips 2 days (`docs/PLAN.md §14`).
- **No application runtime impact yet** — no behavior ships; the deliverables are documents + types that gate subsequent changes.
