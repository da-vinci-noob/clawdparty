## Context

Invites are minted via `POST /api/sessions/:session_id/invites` (owner-gated by `manage_invites`) and returned as a one-time raw `token` (stored SHA-256-digested). The `invite-auth` capability already: stores `revoked_at`/`expires_at`, exposes `Invite#revoke!`/`usable?`/`expired?`/`revoked?`, and refuses non-`usable?` tokens at join with an anti-enumeration `404`. What is missing is any way to **read** a session's invites or **trigger** revocation — the model method has no caller. `Session has_many :invites, dependent: :destroy` already exists. This change adds the management surface only; it introduces no new columns, no new policy key, and no new event types.

## Goals / Non-Goals

**Goals:**
- Let an owner see every invite for a session (count = list length) with enough metadata to decide what to revoke: `id`, `role`, `created_at`, `expires_at`, and a derived `status`.
- Let an owner revoke a specific invite so its link stops working immediately.
- Make a freshly-minted invite immediately revocable from the UI (return its `id` on create).

**Non-Goals:**
- **Per-link usage count** ("used by N participants") — would require an `invite_id` on `participants` and recording it on join. Explicitly deferred; no migration in this change.
- **Re-displaying or regenerating a shareable link** — impossible by design (only the digest is stored); the list is metadata/status only.
- **Bulk "revoke all"**, invite editing, and un-revoke — out of scope.
- Any change to the join flow, the role matrix, or Contract-1 events.

## Decisions

- **New capability, not a contract edit.** New endpoints get their own capability spec here (matching `diff-api`, `file-api`, `directory-picker`), consuming `invite-auth` and the frozen `http-api-contract` role matrix by name rather than modifying the frozen contract. Additive REST only.
- **Reuse the owner-only `manage_invites` permission** for both `index` and `destroy`. Alternative — a separate `revoke_invites` key — rejected: revoking and minting are the same trust level (owner), and a new key would need a matrix change on both the server `SessionPolicy` and the mirrored client matrix. Not worth it.
- **Session-scoped lookup for anti-enumeration.** `destroy` loads the invite via `session.invites.find_by(id:)`, not `Invite.find`, so an invite id from another session yields `404` (consistent with the IDOR-`404` reasoning in `invite-auth`), and the session-participant + `manage_invites` gate still applies.
- **`status` is derived server-side, not stored.** Computed from the existing methods: `revoked?` → `revoked`, else `expired?` → `expired`, else `active`. (`revoked` wins over `expired` if both, matching `usable?` = `!revoked? && !expired?`.) The client renders the server's string; it does not re-derive from timestamps.
- **Revoke is idempotent and returns no body.** `DELETE` → `204 No Content`; calling `revoke!` on an already-revoked invite is a no-op success (it just re-stamps/keeps `revoked_at`). Keeps the client simple and retries safe.
- **List never includes token material.** No `token_digest`, no raw token — only `id`, `role`, `created_at`, `expires_at`, `status`.
- **Frontend uses the existing `useEffect` + `fetch` listing precedent** (`directory_picker.tsx`), refetching after a successful mint or revoke, rather than introducing the first `useQuery` call site. Keeps the change small and consistent with how lists are fetched in this app today; TanStack Query adoption can be a separate refactor.

## Risks / Trade-offs

- **[Owner revokes their own still-valid link and locks themselves out]** → Revocation only affects *future joins*; already-joined participants keep their `clawd_uid` cookie and session participantship (role is re-derived from `participants`, never from the invite). So revoke cannot evict a live participant — matches expectations.
- **[Stale list after another owner mints/revokes concurrently]** → The list is a point-in-time REST read (no cable). Acceptable: it refetches on the owner's own mint/revoke, and invite management is low-frequency. A live-updating list is not worth a new event type.
- **[`status` string drift between server and any future consumer]** → Mitigated by deriving it in one place (the serializer) from the canonical `revoked?`/`expired?` methods and pinning the enum in the spec.
- **[Unbounded list on a session with many invites]** → Invites are minted rarely (one per role, reused); no pagination needed. If that ever changes it is an additive follow-up, not a blocker here.
