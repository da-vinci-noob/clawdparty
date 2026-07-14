## 1. Scaffold the contracts locations

- [x] 1.1 Create `docs/contracts/` directory
- [x] 1.2 Create `packages/contracts/` with `package.json`, `tsconfig.json`, and Biome config matching the repo's strict-TS + Biome conventions (2-space, double quotes, semicolons, `noExplicitAny`, `useImportType`, `noConsole`)
- [x] 1.3 Create `packages/contracts/src/` and `packages/contracts/fixtures/` directories
- [x] 1.4 Verify `tsc` runs clean on the empty package scaffold

## 2. Event envelope contract (freeze-now)

- [x] 2.1 Write `docs/contracts/events.md`: the envelope `{ id, session_id, ai_run_id, seq, type, actor, ts, payload }` with field descriptions
- [x] 2.2 Enumerate the 20 frozen type names + `ai_raw` fallback in `events.md`
- [x] 2.3 Document dual-cursor semantics (per-run `seq`, global `id`), idempotency on `(ai_run_id, seq)`, and dedupe-by-`id`
- [x] 2.4 Document the ephemeral-vs-durable classification (`ai_text_delta`/`presence_changed` ephemeral + ~150ms delta coalescing; `ai_text` durable on block stop) per type
- [x] 2.5 Fix the `actor` representation (at least claude/user/system) and document it
- [x] 2.6 Implement `packages/contracts/src/events.ts`: envelope type + frozen type-name union + a `CONTRACT_VERSION` `{ major, minor }` constant (`minor` bumps on additive CHANGELOG entries, `major` on breaking ones; consumers require exact `major` + `minor` ≥ needed); assert the union matches the doc list
- [x] 2.7 Mark every per-type payload schema explicitly `pending-spike` in both `events.md` and `events.ts` (no silent omissions)

## 3. Sidecar protocol contract (freeze-now)

- [x] 3.1 Write `docs/contracts/sidecar_protocol.md`: Rails→sidecar `POST /runs` (fields + `409` on active run), `POST /runs/:id/messages`, `POST /runs/:id/interrupt`, `GET /healthz`
- [x] 3.2 Document sidecar→Rails `POST /internal/events` (batched, idempotent) and `POST /internal/sidecar/heartbeat` (every 5s, `active_run_ids`), both bearer-authed with `SIDECAR_SHARED_SECRET`
- [x] 3.3 Document the worktree convention: Rails creates `<repo>/.clawdparty/worktrees/session-<id>` (branch `clawd/session-<id>`); sidecar uses it as `cwd`; `base_sha` recorded at run start; consistent path across containers
- [x] 3.4 Document compose-network addressing (`SIDECAR_URL` default `http://sidecar:8787`, configurable callback base) and the no-hard-coded-host rule
- [x] 3.5 Document run-start permission scoping (`permission_mode: acceptEdits`, `allowed_tools`, `cwd` pinned) and the allow-all `canUseTool` MVP seam

## 4. HTTP + cable API contract (freeze-now)

- [x] 4.1 Write `docs/contracts/http_api.md`: REST endpoint list (session create/join, invites, run start, follow-up/interrupt, events backfill, diff, changeset approve/reject, file tree/content)
- [x] 4.2 Document the "all live state is a Contract-1 event, no bespoke cable messages" rule, the `/~cable` mount, and the per-session subscription shape
- [x] 4.3 Document the 4-role matrix (owner/editor/reviewer/viewer) action-by-action, server-enforced, with cable participantship verification
- [x] 4.4 Document invite-link → signed httpOnly `clawd_uid` cookie auth for both REST and cable; diffs REST-only
- [x] 4.5 Document the gap-free late-joiner catch-up sequence (subscribe → buffer → backfill `after=<cursor>` → drain `id > max` → live)

## 5. Spike-gated finalization (Wednesday, after the Tuesday SDK spike)

> **BLOCKED on the Tuesday SDK spike — cannot be completed in Week 1 pre-spike.** 5.4 (the
> "if the spike slips" escape hatch) is done now to unblock downstream ingest plumbing; 5.1–5.3
> and 5.5 stay open by design until real SDK output exists. Do not fabricate payload schemas.

- [ ] 5.1 Capture `packages/contracts/fixtures/sample_run.jsonl` from real spike output as post-normalization contract events (not raw SDK)  — *spike-blocked; interim placeholder in place (5.4)*
- [ ] 5.2 Replace `pending-spike` payload markers with concrete per-type field schemas in `events.md`  — *spike-blocked*
- [ ] 5.3 Implement concrete per-type payload interfaces in `events.ts`; confirm `tsc` passes  — *spike-blocked*
- [x] 5.4 If the spike slips, hand-author an envelope-only `sample_run.jsonl` to unblock ingest plumbing and note the placeholder for replacement  — *done: `{}` payloads, all frozen envelope rules verified by `fixtures/sample_run.test.ts` (6 tests) + `fixtures/README.md` flags the placeholder*
- [ ] 5.5 Resolve the `ai_text_delta` payload `block` field representation from spike output (the key the W2 web reducer accumulates deltas by, per the event-envelope `(ai_run_id, block)` rule) and remove its `pending-spike` marker  — *spike-blocked*

## 6. Governance and freeze gate

- [x] 6.1 Seed `docs/contracts/CHANGELOG.md` with the v1 freeze entry (date + scope)
- [x] 6.2 Document the freeze process in the contracts (additive types = CHANGELOG entry only; envelope/endpoint changes = breaking entry, treated as an emergency)
- [x] 6.3 Document the freeze-now vs spike-gated boundary explicitly so downstream streams know what is safe to build against
- [x] 6.4 Declare the freeze and record it in the CHANGELOG
- [x] 6.5 Cross-check that `docs/contracts/*.md` and `packages/contracts/src/events.ts` agree on envelope + type names before declaring the freeze
