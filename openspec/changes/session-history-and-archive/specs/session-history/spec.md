## ADDED Requirements

### Requirement: A user can list the sessions they host or participate in

The system SHALL expose `GET /api/sessions`, gated only by a valid `clawd_uid` cookie (any
authenticated user; there is no single session to view-gate). It SHALL return the set of sessions
where the caller is the `host` OR has a `participants` row, de-duplicated across the two, ordered
by `last_activity_at` descending. On success it SHALL respond `200` with a JSON array whose
elements each have exactly the keys `id` (string), `title` (string), `mode` (`review`/`chat`),
`status` (`active`/`archived`), `my_role` (one of `owner`/`editor`/`reviewer`/`viewer`),
`owned` (boolean — whether the caller is the session's host), `last_activity_at` (ISO-8601), and
`created_at` (ISO-8601). `my_role` SHALL be the role of the caller's `participants` row for that
session, or `owner` when the caller is the host without a participant row. `owned` lets the client
split the list into the caller's own (hosted) sessions and sessions they only joined. The array SHALL contain only sessions the caller hosts or participates in — never
another user's sessions.

A request without a valid `clawd_uid` cookie SHALL be refused with HTTP `404` and a JSON body of
the shape `{ errors: [...] }` (the app's uniform anti-enumeration posture via the shared
`require_user` helper — no identity is confirmed or denied distinctly).

#### Scenario: Caller sees their hosted and joined sessions, newest activity first

- **WHEN** a user with a valid `clawd_uid` cookie requests `GET /api/sessions`, having created two
  sessions and joined a third
- **THEN** the response is `200` with a JSON array of exactly those three sessions, ordered by
  `last_activity_at` descending, each carrying `id`, `title`, `mode`, `status`, `my_role`,
  `last_activity_at`, and `created_at`

#### Scenario: A session the caller does not belong to is excluded

- **WHEN** a user requests `GET /api/sessions` and another user hosts a session the caller neither
  hosts nor participates in
- **THEN** that session does not appear in the response array

#### Scenario: A session appears once even when the caller is both host and participant

- **WHEN** a user who created a session (and is therefore both its host and its owner participant)
  requests `GET /api/sessions`
- **THEN** that session appears exactly once in the array, with `my_role` of `owner`

#### Scenario: Unauthenticated request is refused

- **WHEN** a request to `GET /api/sessions` carries no valid `clawd_uid` cookie
- **THEN** the server responds `404` with a JSON body of the shape `{ errors: [...] }` (the shared
  `require_user` anti-enumeration posture)

### Requirement: A sessions page lists the caller's sessions, grouped, with an active/revoked badge

The app SHALL provide a dedicated sessions view (route `/sessions`, reachable from a header/nav
link — NOT embedded in the landing marketing page) that fetches `GET /api/sessions` and renders the
caller's sessions in the left panel, split into two groups: "Your sessions" (rows where `owned` is
true) and "Joined" (rows where `owned` is false). Each row SHALL show the title, a last-activity hint, and a status badge
that is **only** "active" (`status` = active) or "revoked" (`status` = archived) — no other status
labels. Each row SHALL link to `/sessions/:id`. For a session the caller owns (`my_role` = owner)
that is not already archived, the row SHALL offer an "end session" control that calls
`POST /api/sessions/:id/archive` and refreshes the list. The client derives the badge and the
owner control from `status` / `my_role` / `owned` for display only; the server enforces access.

#### Scenario: Sessions are grouped into owned vs joined

- **WHEN** the sessions page renders a caller who hosts some sessions and has joined others
- **THEN** hosted sessions (`owned` true) appear under "Your sessions" and joined sessions (`owned`
  false) appear under "Joined"

#### Scenario: Only active/revoked badges are shown

- **WHEN** the list renders a session whose `status` is `archived`
- **THEN** that row shows a "revoked" badge, while `active` sessions show an "active" badge, and no
  other status label (e.g. live/idle/review) is rendered

#### Scenario: An owner can end a session from the list

- **WHEN** an owner clicks "end session" on one of their active sessions
- **THEN** the client calls `POST /api/sessions/:id/archive`, the list refreshes, the row's badge
  becomes "revoked", and the control disappears

#### Scenario: A non-owner sees no end-session control

- **WHEN** the list renders a session the caller only joined (`my_role` is not owner)
- **THEN** no "end session" control is shown for that row

#### Scenario: Each row links into its session

- **WHEN** the user clicks a session row
- **THEN** the app navigates to `/sessions/:id` for that session

#### Scenario: The sessions view is reached from a header link, not the landing body

- **WHEN** the user activates the "sessions" link in the header/nav
- **THEN** the app navigates to the sessions page, and the landing marketing page does not itself
  embed the session-history list
