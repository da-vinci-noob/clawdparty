## Why

Invites today are **write-only**: an owner can mint a role-scoped link, but there is no way to see how many links exist for a session or to kill one that has been over-shared or leaked. The `invite-auth` capability already stores `revoked_at` and refuses revoked tokens at join, and the model already exposes `revoke!` — but no endpoint or UI reaches it, so revocation is unreachable in practice. This closes that gap with a small, owner-gated management surface.

## What Changes

- **List a session's invites** — a new owner-gated `GET /api/sessions/:session_id/invites` returning each invite's `id`, `role`, `created_at`, `expires_at`, and a derived `status` (`active` | `revoked` | `expired`). The "how many tokens exist" count is simply the length of this list.
- **Revoke an invite** — a new owner-gated `DELETE /api/sessions/:session_id/invites/:id` that calls the existing `Invite#revoke!`. Revocation takes effect immediately because the join flow (`invite-auth`) already refuses non-`usable?` tokens.
- **Create response carries the invite `id`** — the existing `POST …/invites` response gains the invite `id` so the UI can revoke a link it just minted without a re-fetch. (Additive field; the one-time raw `token` is unchanged.)
- **Invite management UI** — the existing owner-gated invite panel gains a list of the session's invites (role, status, expiry) with a per-row Revoke button.
- **No token material is ever listed.** Tokens are SHA-256-hashed and the raw token is returned only once at mint; the list exposes metadata and status only and never re-displays a shareable link. A lost link can only be replaced by minting a new one.
- **No usage-count / no schema change.** Per-link "used by N" tracking is explicitly out of scope (it would require an `invite_id` on `participants`); this change reuses existing columns and methods only.

## Capabilities

### New Capabilities
- `invite-management`: owner-gated listing (with derived status + count) and revocation of a session's invite links, plus surfacing the invite `id` on create. Consumes `invite-auth` (revocation semantics, digested tokens, anti-enumeration `404`) and the frozen `http-api-contract` four-role matrix (`manage_invites`, owner-only) rather than re-deriving them.

### Modified Capabilities
<!-- None. Revocation semantics and the role matrix already live in invite-auth / http-api-contract; this change adds a management surface as a new capability (matching the repo pattern where new endpoints — diff-api, directory-picker — are their own capability, not edits to the frozen contract). -->

## Impact

- **api/** — `InvitesController` gains `index` + `destroy` (both `authorize!(:manage_invites, session)`, invite loaded via `session.invites.find_by(id:)` for session-scoping/anti-enumeration); `create` adds `id` to its JSON. `config/routes.rb` extends the nested invites resource from `only: :create` to include `index` + `destroy`. Reuses the existing owner-only `manage_invites` policy key — no `SessionPolicy` matrix change. No migration.
- **web/** — `web/src/components/invite_panel.tsx` gains an invite list + Revoke action, following the `directory_picker.tsx` `useEffect` + `fetch` listing precedent (owner-gate on `manage_invites` already present).
- **Contracts** — contract-neutral: no new Contract-1 event types, no envelope change; purely additive REST.
- **Tests** — request specs for `index`/`destroy` (owner success, non-owner `403`, cross-session/unknown `404`, revoke-then-join-fails); a new `Invite` model spec for `usable?`/`expired?`/`revoked?`/`revoke!`; `:revoked`/`:expired` factory traits; extended `invite_panel.test.tsx`.
