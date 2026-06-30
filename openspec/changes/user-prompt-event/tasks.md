> **Additive contract change (minor bump 1.1 → 1.2).** Order matters: land the contracts package FIRST so
> both sidecar and web compile against the new type, then the sidecar producer, then the web consumer, then
> docs. Spike-independent — `user_prompt` is sidecar-originated, not derived from an SDK message shape.

## 1. Contract (`packages/contracts`)

- [ ] 1.1 Add `"user_prompt"` to `EVENT_TYPES` in `packages/contracts/src/events.ts`
- [ ] 1.2 Add `UserPromptPayload { text: string }` and its `EventPayloadMap.user_prompt` entry
- [ ] 1.3 Bump `CONTRACT_VERSION` to `{ major: 1, minor: 2 }` and update the `EVENT_TYPE_COUNT` freeze guard `20 → 21`
- [ ] 1.4 Confirm the package type-checks (the `PAYLOAD_MAP_COVERS_TAXONOMY` + count guards still hold); build/emit types if the package has a build step
- [ ] 1.5 Add a `docs/contracts/CHANGELOG.md` entry (additive: new `user_prompt` type, minor bump) and a row in `docs/contracts/events.md`; note in `docs/contracts/sdk_mapping.md` that it is sidecar-originated (not an SDK-message mapping)

## 2. Sidecar producer (`sidecar/`)

- [ ] 2.1 Add a `Normalizer` method (e.g. `userPrompt(text)`) that mints a run-scoped `user_prompt` envelope: next monotonic `seq`, `actor` `{ kind: "user", id: ctx.requestedBy }`, payload `{ text }` — reusing the existing `userActor()`/`seq` machinery
- [ ] 2.2 In `runner.ts#startRun`, emit the initial `user_prompt` (ship durable) BEFORE pushing the initial user message — so it takes `seq` 1 and precedes `run_started` (seq 2)
- [ ] 2.3 In `runner.ts#sendMessage`, emit one `user_prompt` BEFORE pushing each follow-up, attributed to the sender, with the next `seq`
- [ ] 2.4 Vitest: on a fresh run `user_prompt` carries `seq` 1 and precedes `run_started`; a follow-up emits exactly one `user_prompt` (right text, next seq, user-attributed) before the pushed message; it ships on the durable path with a non-null seq
- [ ] 2.5 Biome + `tsc` clean for changed sidecar files; full `npx vitest run` green

## 3. Rails consumer (`api/`)

- [ ] 3.1 Confirm `Events::Ingest` persists + broadcasts a `user_prompt` verbatim by `(ai_run_id, seq)` and `Runs::Finalize` leaves run status unchanged (no code change expected — assert via spec)
- [ ] 3.2 Request/service spec: ingesting a `user_prompt` persists it as a durable run-scoped event, broadcasts it, dedupes a repeat `(ai_run_id, seq)`, and does not transition run state
- [ ] 3.3 Confirm the Rails `ContractVersion` consumer still passes against `{ 1, 2 }`; `bin/rspec` (RAILS_ENV=test) + RuboCop green

## 4. Web consumer (`web/`)

- [ ] 4.1 Add `web/src/components/feed/user_prompt_block.tsx` — renders the prompt text attributed to the participant (resolve name from the participant-names helper; generic fallback when unknown), styled distinct from `ai_text` and consistent with the refreshed feed look, with its own `data-testid`
- [ ] 4.2 Add `case "user_prompt"` to `activity_feed.tsx` routing to `UserPromptBlock` (rendered inline in the existing seq-ordered durable list; unknown types still fall through to `RawFallback`)
- [ ] 4.3 Vitest + RTL: a run with `user_prompt` (seq 1) → `run_started` → `ai_text` renders prompt first (attributed), then banner, then Claude text; the prompt uses its dedicated element distinct from the text block
- [ ] 4.4 Biome + `tsc` clean; full `npx vitest run` green

## 5. Validation

- [ ] 5.1 `openspec validate user-prompt-event --type change --strict` passes
- [ ] 5.2 All three suites green: `api` (RSpec + RuboCop), `sidecar` (Biome + tsc + Vitest), `web` (Biome + tsc + Vitest)
- [ ] 5.3 Live smoke: start a run from the browser and confirm the prompt appears in the feed before Claude's reply, and a follow-up appears in order; a late-joining tab backfills the prompt(s)
