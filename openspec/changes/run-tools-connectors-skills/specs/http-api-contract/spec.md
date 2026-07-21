## ADDED Requirements

### Requirement: Run capability discovery endpoints

The contract `docs/contracts/http_api.md` SHALL enumerate two read-only, **session-scoped** discovery endpoints that Rails serves by proxying the sidecar (cached like `GET /api/models`, with the repo path in the cache key): `GET /api/sessions/:id/connectors` and `GET /api/sessions/:id/skills`. The built-in **tools** set is a shared constant (not an endpoint). Each endpoint SHALL pin its success shape — `200` with `{ connectors: [{ name, transport }], source }` and `{ skills: [{ name, description }], source }` respectively — SHALL return an empty list with an unavailable `source` (still `200`) when the underlying config is missing/unparseable, and SHALL respond `502` when the sidecar is unreachable (matching `GET /api/models`). These endpoints gate on participantship (any participant may view); a non-participant/cross-session request SHALL be refused `404 { errors: [...] }` per the anti-enumeration convention. No connector command/url/headers/tokens SHALL ever appear in these responses.

#### Scenario: Connectors/skills are discoverable per session over REST

- **WHEN** a participant calls `GET /api/sessions/:id/connectors` or `GET /api/sessions/:id/skills`
- **THEN** the server responds `200` with the pinned `{ …, source }` shape, resolved against that session's repository path

#### Scenario: Discovery is available to any participant but not cross-session

- **WHEN** a non-participant (or cross-session requester) calls a discovery endpoint
- **THEN** the server responds `404 { errors: [...] }`, indistinguishable from a nonexistent resource

### Requirement: Run start accepts additive capability-selection fields

The contract SHALL document that `POST /api/sessions/:id/runs` accepts three additive, optional body fields alongside the existing `prompt`/`model`/`permission_mode`: `disallowed_tools` (string[]), `connectors` (string[]), and `skills` (`"all"` | string[]). Omitting a field SHALL preserve the prior behavior. A value outside the discovered/known set SHALL be rejected with `422 { errors: [...] }` and start no run; setting these fields SHALL be gated to run-capable roles (owner/editor), so a reviewer/viewer attempt SHALL be denied `403 { errors: [...] }` per the four-role matrix. On success the endpoint SHALL return its existing `202` shape unchanged.

#### Scenario: Capability fields are optional and validated

- **WHEN** an editor starts a run with valid `disallowed_tools`/`connectors`/`skills`
- **THEN** the server responds `202` with the existing `{ id, status }` shape, and an unknown value instead yields `422 { errors: [...] }` with no run started

#### Scenario: Capability selection follows the run role gate

- **WHEN** a reviewer or viewer sends `POST /api/sessions/:id/runs` (with or without capability fields)
- **THEN** the server responds `403 { errors: [...] }`, consistent with the start-run row of the role matrix
