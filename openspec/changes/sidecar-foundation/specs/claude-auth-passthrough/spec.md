## ADDED Requirements

### Requirement: Sidecar relies on the host's existing Claude login and owns no credential

The sidecar SHALL use the host developer's existing Claude login to authenticate to Anthropic and SHALL NOT contain, store, or ship any app-owned Anthropic API key or credential. Authentication SHALL be inherited from the host's process/container environment and mounted credentials (wired by the `dev-docker-compose` change), never embedded in sidecar code or configuration committed to the repo.

#### Scenario: No app-owned credential exists in the sidecar

- **WHEN** the sidecar authenticates to Anthropic
- **THEN** it uses the host developer's inherited login, and there is no app-owned key stored in sidecar code or repo configuration

### Requirement: Auth-method-agnostic — no credential or method selection in code

The sidecar SHALL be agnostic to which Claude auth method the host uses — direct API key, Claude subscription/enterprise OAuth, or Amazon Bedrock — and SHALL contain **no code that selects, prioritizes, or stores** a credential or auth method. The SDK SHALL auto-detect the method in its own precedence order (cloud-provider flag, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then `~/.claude` credentials) from the inherited environment. The authoritative list of passed-through auth environment variables SHALL be the set enumerated by the `dev-docker-compose` change's `claude-credential-mounts` capability (its "Auth-method-agnostic env passthrough, only-when-set" requirement); this spec defers to that capability as the single source of truth for the variable list to avoid duplication-drift, and SHALL NOT re-enumerate or contradict it.

#### Scenario: Any host login mode works without sidecar changes

- **WHEN** the host uses a direct API key, subscription/enterprise OAuth, or Bedrock
- **THEN** the SDK auto-detects the method from the inherited environment and the run authenticates, with no method-selection code in the sidecar

#### Scenario: Sidecar does not pick or store a credential

- **WHEN** multiple auth-related environment variables are present
- **THEN** the sidecar defers entirely to the SDK's precedence order and does not itself choose, reorder, or persist any of them

### Requirement: Documented host auth caveats

The change SHALL document two host-side auth caveats that the sidecar cannot solve in code (because solving them would mean owning or selecting a credential): (a) on macOS, subscription/enterprise OAuth lives in the **Keychain with no file**, invisible to a Linux container, so the host runs `claude setup-token` once and exports `CLAUDE_CODE_OAUTH_TOKEN`; (b) Bedrock-via-AWS-SSO tokens **expire**, so the host must stay `aws sso login`-fresh — the read-only mount reflects the refreshed token but the container cannot refresh it itself.

#### Scenario: macOS Keychain OAuth caveat is documented

- **WHEN** the host authenticates via macOS subscription/enterprise OAuth (Keychain, no file)
- **THEN** the documentation directs the host to run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN`, because the Keychain credential is invisible to the container

#### Scenario: Bedrock-SSO expiry caveat is documented

- **WHEN** the host authenticates via Amazon Bedrock over AWS SSO
- **THEN** the documentation states the host must stay `aws sso login`-fresh, because the container reflects the mounted token but cannot refresh it

### Requirement: canUseTool is an allow-all MVP stub

`sidecar/src/permissions.ts` SHALL implement `canUseTool` as an allow-all stub for the MVP and SHALL be the documented single-file seam for later per-tool Bash gating. It SHALL NOT introduce any shell input path; the terminal pane remains a read-only replay of Claude's Bash events.

#### Scenario: canUseTool allows every tool in the MVP

- **WHEN** the SDK consults `canUseTool` for any tool
- **THEN** the MVP stub allows it, while remaining the documented seam for future per-tool gating

#### Scenario: No shell input path is introduced

- **WHEN** the permissions stub is in place
- **THEN** it does not add any path for input to a shell, preserving the read-only-terminal invariant
