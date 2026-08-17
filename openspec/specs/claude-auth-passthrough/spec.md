# claude-auth-passthrough Specification

## Purpose
TBD - created by archiving change harness-foundation. Update Purpose after archive.
## Requirements
### Requirement: Harness relies on the host's existing Claude login and owns no credential

The harness SHALL use the host developer's existing Claude login to authenticate to Anthropic and SHALL NOT contain, store, or ship any app-owned Anthropic API key or credential. Authentication SHALL be inherited from the host's process/container environment and mounted credentials (wired by the `dev-docker-compose` change), never embedded in harness code or configuration committed to the repo.

#### Scenario: No app-owned credential exists in the harness

- **WHEN** the harness authenticates to Anthropic
- **THEN** it uses the host developer's inherited login, and there is no app-owned key stored in harness code or repo configuration

### Requirement: Auth-method-agnostic — no credential or method selection in code

The harness SHALL be agnostic to which Claude auth method the host uses — direct API key, Claude subscription/enterprise OAuth, or Amazon Bedrock — and SHALL contain **no code that selects, prioritizes, or stores** a credential or auth method. The SDK SHALL auto-detect the method in its own precedence order (cloud-provider flag, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then `~/.claude` credentials) from the inherited environment. The authoritative list of passed-through auth environment variables SHALL be the set enumerated by the `dev-docker-compose` change's `claude-credential-mounts` capability (its "Auth-method-agnostic env passthrough, only-when-set" requirement); this spec defers to that capability as the single source of truth for the variable list to avoid duplication-drift, and SHALL NOT re-enumerate or contradict it.

#### Scenario: Any host login mode works without harness changes

- **WHEN** the host uses a direct API key, subscription/enterprise OAuth, or Bedrock
- **THEN** the SDK auto-detects the method from the inherited environment and the run authenticates, with no method-selection code in the harness

#### Scenario: Harness does not pick or store a credential

- **WHEN** multiple auth-related environment variables are present
- **THEN** the harness defers entirely to the SDK's precedence order and does not itself choose, reorder, or persist any of them

### Requirement: Documented host auth caveats

The change SHALL document two host-side auth caveats that the harness cannot solve in code (because solving them would mean owning or selecting a credential): (a) on macOS, subscription/enterprise OAuth lives in the **Keychain with no file**, invisible to a Linux container, so the host runs `claude setup-token` once and exports `CLAUDE_CODE_OAUTH_TOKEN`; (b) Bedrock-via-AWS-SSO tokens **expire**, so the host must stay `aws sso login`-fresh — the read-only mount reflects the refreshed token but the container cannot refresh it itself.

#### Scenario: macOS Keychain OAuth caveat is documented

- **WHEN** the host authenticates via macOS subscription/enterprise OAuth (Keychain, no file)
- **THEN** the documentation directs the host to run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN`, because the Keychain credential is invisible to the container

#### Scenario: Bedrock-SSO expiry caveat is documented

- **WHEN** the host authenticates via Amazon Bedrock over AWS SSO
- **THEN** the documentation states the host must stay `aws sso login`-fresh, because the container reflects the mounted token but cannot refresh it

### Requirement: The command gate is a real interception point

The harness SHALL expose exactly one place that can refuse a model-directed command — the `tool:before`
extension point — and it SHALL have at least one importer in the tree, enforced by `bin/check-docs`.

<!-- doc-truth:ignore -->
This requirement replaces "canUseTool is an allow-all MVP stub". That hook was exported, documented as the seam
for later per-tool gating, and imported by nothing: it could not intercept a call. It was DELETED rather than
left in place, because a seam presented as one that cannot intercept is worse than an absent one — a reader
plans around it. The read-only-terminal invariant it was cited for is unchanged and is asserted directly by
`harness/test/security/no_shell_input.test.ts`.
<!-- doc-truth:end -->

#### Scenario: The gate can actually refuse

- **WHEN** the model directs a `bash` command and a rule refuses it at `tool:before`
- **THEN** the command does not execute and the feed shows the refusal with its reason

#### Scenario: No shell input path exists

- **WHEN** any participant-facing surface is inspected
- **THEN** no path for input to a shell exists; the terminal pane is a read-only replay of Claude's Bash events

