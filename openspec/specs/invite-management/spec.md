# invite-management Specification

## Purpose
TBD - created by archiving change invite-management. Update Purpose after archive.
## Requirements
### Requirement: Owner can list a session's invites with derived status

The system SHALL expose `GET /api/sessions/:session_id/invites`, gated by the `manage_invites` permission (owner-only per the frozen `http-api-contract` role matrix). On success it SHALL respond `200` with a JSON array of the session's invites, each object having exactly the keys `id` (string), `role` (one of `owner`/`editor`/`reviewer`/`viewer`), `created_at` (ISO-8601), `expires_at` (ISO-8601 or `null`), and `status`. `status` SHALL be derived server-side as `revoked` when the invite is revoked, else `expired` when it is expired, else `active` (revoked takes precedence over expired). The count of a session's invite tokens is the length of this array. The response SHALL NOT include the `token_digest` or any raw token material — the raw token is derivable only at mint time and links are never re-displayed. The list SHALL be scoped to the target session only.

A request from a participant whose role lacks `manage_invites` SHALL be refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`. A request for a session the caller is not a participant of, or that does not exist, SHALL be refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }` (the two cases are not distinguished, consistent with `invite-auth` anti-enumeration).

#### Scenario: Owner lists invites with count and status

- **WHEN** an owner requests `GET /api/sessions/:session_id/invites` for a session with several invites (some active, one revoked, one expired)
- **THEN** the response is `200` with a JSON array whose length is the invite count, each item carrying `id`, `role`, `created_at`, `expires_at`, and a `status` of `active` / `revoked` / `expired` derived server-side, and no field exposes token material

#### Scenario: Non-owner participant is denied the list

- **WHEN** an `editor`, `reviewer`, or `viewer` participant requests the invite list
- **THEN** the request is refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`

#### Scenario: Non-participant or unknown session is refused with 404

- **WHEN** a caller who is not a participant of the session (or names a session that does not exist) requests the invite list
- **THEN** the request is refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`, the two cases indistinguishable

### Requirement: Owner can revoke a session's invite

The system SHALL expose `DELETE /api/sessions/:session_id/invites/:id`, gated by the `manage_invites` permission (owner-only). The invite SHALL be loaded scoped through the session (`session.invites.find_by(id:)`) so an id belonging to another session is treated as not found. On success it SHALL mark the invite revoked via the existing `Invite#revoke!` and respond `204` with no body. Revocation SHALL be idempotent: revoking an already-revoked invite SHALL also respond `204`. Because the join flow already refuses any non-`usable?` invite, a revoked invite SHALL immediately be unusable to join; revocation SHALL NOT affect participants who have already joined (their participantship and role are re-derived from `participants`, never from the invite).

A request from a participant whose role lacks `manage_invites` SHALL be refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`. A request naming an invite id that is not in the target session (including a non-existent id or one from another session), or a session the caller is not a participant of (or that does not exist), SHALL be refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`.

#### Scenario: Owner revokes an invite and it can no longer be used to join

- **WHEN** an owner sends `DELETE /api/sessions/:session_id/invites/:id` for a usable invite, and someone then attempts to join with that invite's token
- **THEN** the delete responds `204` with no body, the invite is marked revoked, and the subsequent join is refused with HTTP `404` and no participant is created

#### Scenario: Revoke is idempotent

- **WHEN** an owner revokes an invite that is already revoked
- **THEN** the response is `204` with no body and the invite remains revoked

#### Scenario: Non-owner participant is denied revoke

- **WHEN** an `editor`, `reviewer`, or `viewer` participant sends the revoke request
- **THEN** the request is refused with HTTP `403` and a JSON body of the shape `{ errors: [...] }`, and the invite is not revoked

#### Scenario: Invite id from another session is not found

- **WHEN** an owner of session A sends a revoke request for an invite id that belongs to session B
- **THEN** the request is refused with HTTP `404` and a JSON body of the shape `{ errors: [...] }`, and the session-B invite is not revoked

#### Scenario: Revoking does not evict already-joined participants

- **WHEN** a participant has already joined using an invite, and an owner then revokes that invite
- **THEN** the already-joined participant retains their session participantship and role, because role is re-derived from `participants` and never from the invite

### Requirement: Invite creation returns the invite id

The existing `POST /api/sessions/:session_id/invites` response SHALL additionally include the created invite's `id` (string) alongside the existing one-time `token`, `role`, and `session_id`, so a client can immediately manage (e.g. revoke) a link it just minted without re-fetching the list. This SHALL be additive: the one-time raw `token` field and its semantics (returned only at mint, never again) are unchanged.

#### Scenario: Create response carries the invite id and the one-time token

- **WHEN** an owner mints an invite via `POST /api/sessions/:session_id/invites`
- **THEN** the `201` response includes the invite `id`, the one-time raw `token`, the `role`, and the `session_id`, and the `token` is still returned only at this mint time

