# Raw SDK message fixtures (sidecar-owned)

These are the **raw** `@anthropic-ai/claude-agent-sdk` message shapes captured
from the Tuesday Week-1 SDK spike — the **input** to the normalizer unit tests.

They are deliberately **distinct** from
`packages/contracts/fixtures/sample_run.jsonl`, which is the **post-normalization
output** (Contract-1 envelopes) owned by the `freeze-interface-contracts` change.

## Status: pending-spike

The raw fixtures and the full per-type mapping table are **gated on the Tuesday
SDK spike** and are not invented from guessed shapes pre-spike. Once the spike
lands:

1. capture real raw SDK messages here (e.g. `raw_run.jsonl`);
2. implement the per-type mapping in `src/normalizer.ts`;
3. add the cross-check test (task 5.4): feeding these raw fixtures through the
   normalizer produces Contract-1 events **equal to**
   `packages/contracts/fixtures/sample_run.jsonl` — drift fails CI.

The committed v1 normalizer behavior (never-crash unknown → `ai_raw`,
redact-then-truncate, ephemeral classification, per-run `seq`, actor stamping)
is tested in `test/normalizer.test.ts` without needing these raw fixtures.
