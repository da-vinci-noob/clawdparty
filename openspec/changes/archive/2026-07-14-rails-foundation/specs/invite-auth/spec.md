## ADDED Requirements

### Requirement: Role-scoped invite links with digested tokens

The system SHALL allow generating role-scoped invite links. Each invite SHALL store a SHA-256 `token_digest` (never the raw token), a `role` (one of `owner`/`editor`/`reviewer`/`viewer`), and an optional `expires_at`, and SHALL support revocation. The raw token SHALL be generated from a CSPRNG with at least 32 bytes of entropy before SHA-256 digesting. The raw token SHALL be derivable only at generation time and matched on join by hashing the presented token and looking up the digest. An expired or revoked invite SHALL NOT be usable to join.

#### Scenario: Invite token is generated from a CSPRNG with at least 32 bytes of entropy

- **WHEN** an invite is generated
- **THEN** the raw token MUST be drawn from a CSPRNG with at least 32 bytes of entropy before it is SHA-256 digested for storage

#### Scenario: Invite stores only the token digest

- **WHEN** an invite is generated for a given role
- **THEN** the database stores the SHA-256 digest of the token, not the raw token, along with the role and optional expiry

#### Scenario: Expired or revoked invite cannot be used

- **WHEN** a user attempts to join with a token whose invite is expired or revoked
- **THEN** the join is refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`, and no participant is created

### Requirement: Join exchanges an invite for a signed cookie

Joining SHALL require a valid invite token and a display name. On success the system SHALL find or create a `User` for the display name, create a `Participant` for the session carrying the invite's role, set a signed httpOnly `clawd_uid` cookie, and respond `200` (or `201`). The cookie SHALL NOT carry the `Secure` flag (the LAN is plain HTTP). The same signed `clawd_uid` cookie SHALL authenticate both subsequent REST requests and the ActionCable connection. Each join SHALL create a **distinct** `Participant`, even when the same `User` is found-or-created (for example the same display name re-joining), so each participant id — which the event-envelope `actor.id` carries — stays unique per join.

A join with an invalid, expired, or revoked invite token SHALL be refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`; these three cases SHALL NOT be distinguished from one another, so the response never confirms whether a given token exists (anti-enumeration, consistent with the IDOR `404`-not-`403` reasoning used elsewhere in this change). A join with a missing or blank display name SHALL be refused with HTTP `422` and a JSON body of the shape `{ errors: [...] }`. No `Participant` SHALL be created on any refused join.

#### Scenario: Valid join issues the clawd_uid cookie

- **WHEN** a user joins with a valid invite token and a display name
- **THEN** the response is `200` (or `201`), a participant with the invite's role is created, and a signed httpOnly `clawd_uid` cookie (without the `Secure` flag) is set

#### Scenario: Invalid, expired, or revoked token is refused with 404

- **WHEN** a user attempts to join with an invite token that is invalid, expired, or revoked
- **THEN** the join is refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`, the three cases are not distinguished from one another, and no participant is created

#### Scenario: Missing or blank display name is refused with 422

- **WHEN** a user attempts to join with a valid invite token but a missing or blank display name
- **THEN** the join is refused with HTTP `422` and a JSON body of the shape `{ errors: [...] }`, and no participant is created

#### Scenario: One cookie authenticates REST and cable

- **WHEN** a joined participant holding the signed `clawd_uid` cookie makes a REST request and opens the cable connection
- **THEN** the same cookie authenticates both, with no separate credential required for cable

#### Scenario: Client cannot override role on join

- **WHEN** a join request includes a role parameter different from the invite's role
- **THEN** the param is ignored and the participant is created with the invite-derived role

#### Scenario: Each join creates a distinct Participant even when the User is reused

- **WHEN** two joins use the same display name (so the same `User` is found-or-created)
- **THEN** each join creates a distinct `Participant` row, so each participant id — and thus each `actor.id` — is unique per join, even though the `User` may be reused

### Requirement: SessionPolicy enforces the four-role matrix server-side

A `SessionPolicy` PORO SHALL gate every controller action against the participant's role per the frozen http-api-contract role matrix (the action×role table), which is the single source of truth for which role may perform which action — this requirement SHALL NOT re-enumerate that matrix in prose, to avoid drift. Enforcement SHALL be server-side and independent of what the client UI shows; the client only hides buttons. On denial, `SessionPolicy` SHALL cause the request to be rejected with HTTP `403` and a JSON body of the shape `{ errors: [...] }` (rendered by the `rescue_from` → `render json: { errors: [...] }, status:` path).

The `clawd_uid` cookie SHALL carry only a stable user id, never a session scope or role. For every request, `SessionPolicy` SHALL re-derive the user's participantship (and thus role) for the **target** session from the `participants` table — one user may be a participant of multiple sessions with different roles — so the cookie's claim is never trusted for session scoping or role.

#### Scenario: Non-owner is denied approve/reject by the server

- **WHEN** a participant whose role is not `owner` requests an owner-only action such as approve or reject
- **THEN** `SessionPolicy` denies it server-side regardless of the client UI

#### Scenario: Authorization re-derives participantship for the target session

- **WHEN** a user holding a valid `clawd_uid` cookie requests an action on a session
- **THEN** `SessionPolicy` looks up that user's `Participant` (and role) for that specific session and authorizes against it, rather than trusting any session/role claim from the cookie

#### Scenario: Role determines allowed actions

- **WHEN** a controller action runs for a participant
- **THEN** `SessionPolicy` permits it only if the participant's role grants that action per the frozen http-api-contract role matrix, otherwise the request is rejected with HTTP `403` and a JSON body of the shape `{ errors: [...] }`

### Requirement: Cable connection authentication and channel participantship

`ApplicationCable::Connection` SHALL authenticate via the signed `clawd_uid` cookie using `identified_by :current_user`, a `find_verified_user` lookup, and `reject_unauthorized_connection`. Independently of REST policy, every session channel subscription SHALL verify that the connected user is a participant of that session before streaming, and SHALL reject the subscription otherwise.

#### Scenario: Unauthenticated connection is rejected

- **WHEN** a cable connection presents no valid signed `clawd_uid` cookie
- **THEN** `find_verified_user` fails and the connection is rejected via `reject_unauthorized_connection`

#### Scenario: Non-participant subscription is rejected

- **WHEN** an authenticated user attempts to subscribe to a session channel for a session they are not a participant of
- **THEN** the channel independently verifies participantship, finds none, and rejects the subscription

### Requirement: Signed cookies work under API-only mode

Because the app runs API-only (`config.api_only = true`), which omits the cookie middleware by default, the app SHALL explicitly re-enable signed cookies — `config.middleware.use ActionDispatch::Cookies` and `include ActionController::Cookies` in the base API controller — so the signed httpOnly `clawd_uid` cookie can be both set (in controllers) and read. Without this, `ActionController::API` does not include cookie support and `cookies.signed[:clawd_uid] = ...` in a controller silently no-ops even though ActionCable can still read the signed cookie via its own cookie jar.

#### Scenario: Signed cookie set on join is readable on a later REST request

- **WHEN** a join sets the signed `clawd_uid` cookie and a later REST request reads it
- **THEN** both succeed because the cookie middleware is explicitly re-enabled despite `config.api_only = true`
