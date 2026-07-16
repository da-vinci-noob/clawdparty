## 1. Backend — routes & controller

- [x] 1.1 Extend the nested invites resource in `api/config/routes.rb` from `only: :create` to `only: %i[create index destroy]`.
- [x] 1.2 Add `InvitesController#index`: `authorize!(:manage_invites, session)`, load `session.invites`, render `200` with a serialized array (`id`, `role`, `created_at`, `expires_at`, `status`) — never token material.
- [x] 1.3 Add `InvitesController#destroy`: load via `session.invites.find_by(id: params[:id])` (→ `404` when nil, anti-enumeration), `authorize!(:manage_invites, session)`, call `invite.revoke!`, render `204` no body; idempotent on an already-revoked invite.
- [x] 1.4 Add the invite `id` to the existing `create` JSON response (additive; keep the one-time `token`, `role`, `session_id`).
- [x] 1.5 Add a small invite serializer/helper deriving `status` (`revoked` if `revoked?`, else `expired` if `expired?`, else `active`) so `index` and any future consumer share one definition.

## 2. Backend — tests

- [x] 2.1 Add `:revoked` and `:expired` traits to `api/spec/factories/invites.rb`.
- [x] 2.2 New `api/spec/models/invite_spec.rb`: cover `usable?`, `expired?`, `revoked?`, `revoke!` (incl. revoke! idempotency and that `usable?` flips false after revoke/expiry).
- [x] 2.3 Extend `api/spec/requests/invites_spec.rb` for `index`: owner `200` with correct item shape + derived `status` for active/revoked/expired; non-owner roles `403`; non-participant/unknown session `404`; response excludes token material.
- [x] 2.4 Extend `invites_spec.rb` for `destroy`: owner `204` + invite becomes revoked; revoke-then-join refused `404` (no participant created); idempotent second revoke `204`; non-owner `403`; invite id from another session `404`; already-joined participant keeps participantship after revoke.
- [x] 2.5 Assert `create` now returns `id` alongside `token`/`role`/`session_id`.

## 3. Frontend — invite panel

- [x] 3.1 Extend `web/src/components/invite_panel.tsx` to fetch `GET /api/sessions/:id/invites` (useEffect + fetch, `credentials: "include"`, cancelled-guard per the `directory_picker.tsx` precedent) and render a list: role, status badge, expiry (or "never").
- [x] 3.2 Add a per-row Revoke button calling `DELETE /api/sessions/:id/invites/:invite_id`; on success refetch (or optimistically mark revoked); surface errors; disable/hide for already-revoked rows.
- [x] 3.3 Refetch the list after a successful mint so a newly-created invite appears (using the `id` now returned by create).
- [x] 3.4 Keep the whole panel owner-gated on the existing `can("manage_invites")`; the list/revoke controls render only for owners.

## 4. Frontend — tests

- [x] 4.1 Extend `web/src/components/invite_panel.test.tsx` (MSW): owner sees the invite list with statuses; Revoke calls DELETE and the row updates; a revoke failure surfaces an error; non-owner renders nothing.

## 5. Verification

- [x] 5.1 `bin/rspec` (api, 254 examples) and web Vitest (70) green; RuboCop (94 files) + Biome + tsc clean.
- [x] 5.2 `openspec validate invite-management` passes; revoke-then-join → `404` is covered by request spec (`does not evict already-joined participants` + revoke-then-join tests).
