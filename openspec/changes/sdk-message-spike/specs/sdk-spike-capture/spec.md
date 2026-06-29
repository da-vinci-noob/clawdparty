## ADDED Requirements

### Requirement: Spike harness runs a real query() using the host's inherited login

The sidecar SHALL contain a spike harness that runs a real `@anthropic-ai/claude-agent-sdk` `query()` against
a throwaway git repository bind-mounted at `/repo`, exercising a representative run: assistant text, thinking,
at least one file-editing tool call, at least one Bash command, and run completion/result. The harness SHALL
authenticate using the host developer's inherited Claude login (the SDK auto-detects from the passed-through
environment and read-only mounts), and SHALL contain no app-owned credential and no auth-method selection,
consistent with the `claude-auth-passthrough` capability.

#### Scenario: Spike authenticates via the host login with no app-owned credential

- **WHEN** the spike harness runs `query()` in the sidecar container
- **THEN** it authenticates using the host's inherited login (API key, subscription/enterprise OAuth, or
  Bedrock — whichever the host has) and contains no app-owned credential or method-selection code

#### Scenario: Spike exercises a representative run

- **WHEN** the spike harness runs against the throwaway repo
- **THEN** the run produces assistant text, thinking, at least one file-editing tool call, at least one Bash
  command, and a run-completion/result message

### Requirement: Raw SDK messages are captured verbatim to the sidecar-owned fixture

The harness SHALL write every raw SDK message yielded by `query()` verbatim to
`sidecar/test/fixtures/raw_run.jsonl` — the raw-input fixture owned by the sidecar stream, distinct from the
post-normalization `packages/contracts/fixtures/sample_run.jsonl`. The capture SHALL NOT transform, redact, or
reorder messages (redaction is the normalizer's runtime job, verified separately): messages SHALL be written in
the exact order `query()` yields them, so the fixture is a deterministic, replayable input for the normalizer
tests rather than a nondeterministically-interleaved log. Before the fixture is committed, it SHALL be reviewed
to contain no real secret, and the prompt/repo SHALL be scoped so no credential is in capture scope.

#### Scenario: Every raw message is captured unmodified and in yield order

- **WHEN** the spike `query()` yields SDK messages
- **THEN** each is written verbatim to `sidecar/test/fixtures/raw_run.jsonl` in the exact order `query()` yielded
  it, with no transformation or reordering, so the fixture replays deterministically through the normalizer

#### Scenario: Raw fixture is distinct from the contract fixture

- **WHEN** the fixtures are inspected
- **THEN** `sidecar/test/fixtures/raw_run.jsonl` holds raw SDK messages (normalizer input) while
  `packages/contracts/fixtures/sample_run.jsonl` holds post-normalization Contract-1 envelopes (the executable
  contract)

#### Scenario: Captured fixture is reviewed for secrets before commit

- **WHEN** the raw fixture is prepared for commit
- **THEN** it is reviewed to contain no real credential, and the capture prompt/repo were scoped so none was in
  scope

### Requirement: The spike blocks rather than fabricating when auth is unavailable

If the host Claude login is not usable in the environment at apply time, the capture SHALL be marked blocked and
NO mapping or fixture SHALL be hand-fabricated, so the downstream payload finalization stays gated rather than
landing invented schemas (honoring `docs/PLAN.md §11`: schemas invented before the spike are fiction). "Not
usable" SHALL include: no auth detected by the SDK (no API key / OAuth token / Bedrock config in the inherited
environment), an authentication rejection (`401`/`403`-equivalent from the SDK), or a run that cannot complete
(e.g. persistent `429`/network failure). On any of these the harness SHALL NOT write a partial
`raw_run.jsonl` — a partial or empty capture SHALL NOT be promoted to the contract fixture, so the change cannot
land with an incomplete or invented mapping.

#### Scenario: Unusable auth blocks the capture instead of guessing

- **WHEN** the host login cannot authenticate a `query()` at apply time (no auth detected, an auth rejection, or
  a run that cannot complete due to persistent `429`/network failure)
- **THEN** the capture is marked blocked, NO partial `raw_run.jsonl` is written and promoted, and no per-type
  mapping or fixture is fabricated, leaving the payload schemas `pending-spike`
