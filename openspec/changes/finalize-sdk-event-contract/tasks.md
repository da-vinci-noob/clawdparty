## 1. SDK spike capture (host activity — needs real Claude login + a disposable repo)

- [ ] 1.1 Create a throwaway git repo as the target; start a run via the pinned `@anthropic-ai/claude-agent-sdk` `query()` with streaming input, `includePartialMessages`, `cwd`, `acceptEdits`
- [ ] 1.2 Exercise and record raw messages for: text streaming, thinking, Bash, Edit/Write, successful result, failure, interrupt, follow-up, resume
- [ ] 1.3 Save the raw messages to `sidecar/test/fixtures/raw_run.jsonl`; note the exact pinned SDK version used
- [ ] 1.4 Inspect the capture for the `ai_text_delta` per-block identifier (the `block` key) and any message shapes not covered by the 20 types

## 2. Concrete payload schemas (derived from the capture)

- [ ] 2.1 Document concrete per-type `payload` field schemas in `docs/contracts/events.md §6/§8`; remove every `pending-spike` marker (incl. §9's spike-gated column)
- [ ] 2.2 Replace the `unknown` stubs in `packages/contracts/src/events.ts` `EventPayloadMap` with typed interfaces; `tsc` passes
- [ ] 2.3 Resolve and document the `ai_text_delta` `block` representation; remove its `pending-spike` marker

## 3. Executable fixture

- [ ] 3.1 Replace `packages/contracts/fixtures/sample_run.jsonl` with real spike-derived post-normalization envelopes (concrete payloads) covering the scenarios in 1.2
- [ ] 3.2 Remove the placeholder warning in `packages/contracts/fixtures/README.md`
- [ ] 3.3 Extend `packages/contracts/fixtures/sample_run.test.ts` to assert concrete payloads (keep all frozen-envelope assertions)

## 4. Normalizer mapping

- [ ] 4.1 Implement the per-type raw→Contract-1 mapping in `sidecar/src/normalizer.ts` for each captured type; durable events advance per-run `seq`; `ai_text_delta` ephemeral + coalesced; unknown/malformed → `ai_raw` (never crash)
- [ ] 4.2 Add the cross-check test: `normalize(raw_run.jsonl)` equals `packages/contracts/fixtures/sample_run.jsonl`

## 5. Governance

- [ ] 5.1 Bump `CONTRACT_VERSION` (additive minor) in `packages/contracts/src/events.ts`
- [ ] 5.2 Add a `docs/contracts/CHANGELOG.md` entry (additive minor; note the pinned SDK version); move the spike-gated items from "deferred" to shipped
- [ ] 5.3 Check off `freeze-interface-contracts` tasks 5.1, 5.2, 5.3, 5.5 (now satisfied)

## 6. Verification gate

- [ ] 6.1 `npm --prefix packages/contracts run typecheck && npm --prefix packages/contracts test` (Node 24)
- [ ] 6.2 `docker compose run --rm sidecar npm run typecheck && docker compose run --rm sidecar npm test` (normalizer mapping + cross-check green)
- [ ] 6.3 `bin/rails fake_claude:replay` renders the new fixture through real ingest with no errors
