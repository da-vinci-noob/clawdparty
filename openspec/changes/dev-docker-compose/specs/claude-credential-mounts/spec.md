## ADDED Requirements

### Requirement: Sidecar read-only mounts host ~/.claude and ~/.aws

The `sidecar` service SHALL bind-mount the host's `~/.claude` and `~/.aws` directories into the container **read-only**. These mounts are how the host developer's existing Claude/AWS login reaches the sidecar; the sidecar SHALL NOT own or ship its own Anthropic credential.

#### Scenario: Host login directories are mounted into the sidecar

- **WHEN** the `sidecar` container starts
- **THEN** the host `~/.claude` and `~/.aws` directories are mounted into the container so the developer's existing login is available

#### Scenario: Mounts are read-only

- **WHEN** the `~/.claude` and `~/.aws` directories are mounted
- **THEN** they are mounted read-only

### Requirement: Credential mount target matches the sidecar user's home so ~ resolves

The container-side target of the `~/.claude` and `~/.aws` mounts SHALL be the home directory of the user the `sidecar` process runs as, so that `~` (and therefore `~/.claude` / `~/.aws`) resolves to the mounted credentials. The `sidecar` SHALL run as the non-root `node` user (the `node:24` base image's default non-root user, home `/home/node`), so the mounts SHALL target `/home/node/.claude` and `/home/node/.aws`. The change SHALL pin this user explicitly, and the mount path SHALL track that user's home (`/home/node`) rather than a hardcoded `/root`, so credential resolution is deterministic.

#### Scenario: Mount target follows the sidecar user's home

- **WHEN** the `sidecar` process runs as the non-root `node` user (home `/home/node`)
- **THEN** the `~/.claude` and `~/.aws` mounts target `/home/node/.claude` and `/home/node/.aws`, so `~/.claude` resolves to the mounted credentials and file-based login is found

### Requirement: Auth-method-agnostic env passthrough, only-when-set

The `sidecar` service SHALL pass through the host's Claude/AWS auth environment variables so the SDK auto-detects whichever login method the developer already uses (direct API key, Claude subscription/enterprise OAuth, or Amazon Bedrock). The pass-through variables SHALL be `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`, `AWS_REGION`, and `ANTHROPIC_MODEL`. Each variable SHALL be passed through **only when it is set on the host** (so an unset variable is not forced to empty), preserving the SDK's own auto-detection and precedence order. The compose file SHALL NOT select, reorder, or hard-code an auth method or credential.

#### Scenario: Any host login mode works without compose changes

- **WHEN** the host developer uses a direct API key, subscription/enterprise OAuth, or Bedrock
- **THEN** the relevant set variables are inherited by the `sidecar` container and the SDK authenticates with that method, with no method selection in the compose file

#### Scenario: Unset variables are not forced to empty

- **WHEN** one of the pass-through variables is not set on the host
- **THEN** it is not injected as an empty value into the container, so the SDK's auto-detection is not disturbed

#### Scenario: No credential or method is hard-coded

- **WHEN** the compose configuration is inspected
- **THEN** it contains no app-owned Anthropic credential and no logic that picks or reorders an auth method

### Requirement: An absent host credential dir mounts empty and auth falls through to the env-var path

When a host `~/.claude` or `~/.aws` directory is absent, the bind mount SHALL resolve to an empty directory rather than blocking startup, and credential resolution SHALL fall through to the environment-variable auth path (e.g. `ANTHROPIC_API_KEY`). A developer who authenticates only via an environment-variable API key — and therefore has no file-based Claude login — SHALL be able to run a Claude session in the sidecar with the empty mount in place. To avoid Docker silently creating a missing source as a root-owned directory, `bin/setup` ensures these directories exist (see `dev-entrypoint`'s "bin/setup ensures the host credential directories exist" requirement); this requirement documents that an empty mount is harmless and auth still works via the env-var path.

#### Scenario: API-key-only developer authenticates with empty credential mounts

- **WHEN** a developer who uses only an environment-variable API key (no file-based `~/.claude` login) starts the `sidecar` with empty `~/.claude` and `~/.aws` mounts
- **THEN** the empty mounts do not break startup and the SDK authenticates via the environment-variable path

### Requirement: Read-only mounts guarantee host login tamper-safety

Because the `~/.claude` and `~/.aws` mounts are read-only, a Claude run SHALL NOT be able to write to or tamper with the host's login state from inside the container. Because `~/.aws` is mounted read-only, the container relies on the **host** to refresh SSO/STS tokens (the host stays `aws sso login`-fresh and the read-only mount reflects the refreshed token); the container SHALL NOT attempt token refresh or SDK credential-cache writes into the read-only mount, and any such write failure from the AWS SDK is expected and SHALL NOT be treated as fatal. (This complements the Bedrock-over-SSO token-expiry caveat below.)

#### Scenario: A run cannot modify host credentials

- **WHEN** code running inside the `sidecar` container attempts to write to the mounted `~/.claude` or `~/.aws`
- **THEN** the write is rejected because the mounts are read-only, leaving the host login state intact

### Requirement: macOS Keychain OAuth caveat is documented

The change SHALL document that on macOS, Claude subscription/enterprise OAuth lives in the **Keychain with no file on disk**, so it is invisible to the Linux container. The documentation SHALL direct the host developer to run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN`, which is then passed through to the sidecar. This caveat SHALL be documented in the `README.md` (which already carries the Bedrock/Keychain setup notes) and the eventual `docs/RUNBOOK.md`.

#### Scenario: Keychain-OAuth host runs setup-token

- **WHEN** the host authenticates via macOS subscription/enterprise OAuth (Keychain, no file)
- **THEN** the documentation directs the developer to run `claude setup-token` once and export `CLAUDE_CODE_OAUTH_TOKEN` so the sidecar inherits a usable token

### Requirement: Bedrock-over-SSO token expiry caveat is documented

The change SHALL document that Bedrock-via-AWS-SSO tokens expire, so the host must keep `aws sso login` fresh. The read-only `~/.aws` mount reflects the refreshed token, but the container cannot refresh the token itself. This caveat SHALL be documented in the `README.md` (which already carries the Bedrock/Keychain setup notes) and the eventual `docs/RUNBOOK.md`.

#### Scenario: Bedrock-SSO host keeps login fresh

- **WHEN** the host authenticates via Amazon Bedrock over AWS SSO
- **THEN** the documentation states the host must stay `aws sso login`-fresh, because the read-only mount reflects the refreshed token but the container cannot refresh it itself
