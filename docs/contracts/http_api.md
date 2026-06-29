# Contract 3 — Client-facing REST + cable API

> **Status: FROZEN.** Endpoint surface, response-shape conventions, the cable mount + rule, the
> 4-role matrix, the auth model, and the catch-up algorithm are frozen now (no spike dependency).
> Changes after the freeze are recorded in [`CHANGELOG.md`](./CHANGELOG.md).

This is the surface the browser (`web/`) builds against. **Every live update arrives as a
[Contract-1 event envelope](./events.md) over the cable — there are no bespoke cable message
types.** Diffs are the one large payload that goes over **REST, never cable**.

## 1. Response-shape conventions (pinned once)

- **Success** shapes are per-endpoint (below).
- **Errors** are always `{ "errors": [ { "message": "<human-readable>", ... }, ... ] }`. Each
  element is an object with at least a `message` string; additional fields (e.g. a `code`) MAY be
  added **additively**. This matches the Rails `rescue_from` → `render json: { errors }`
  convention and makes every role-gated endpoint testable the same way.

### `403` vs `404` — the anti-enumeration rule

| situation | status |
|---|---|
| A **participant of the session** requests an action their **role** does not permit | **`403`** `{ errors }` |
| A requester accesses a session they are **not a participant of**, OR presents an **invalid/expired/revoked invite token**, OR a genuinely nonexistent resource | **`404`** `{ errors }`, **indistinguishable** from each other |

`404` never confirms existence (anti-enumeration / IDOR). `403` is reserved for the known
participant whose action is denied. Downstream specs (`invite-auth`, `event-ingest-pipeline`)
implement this convention; it is pinned here as the single source.

## 2. REST endpoint surface

| area | endpoint(s) |
|---|---|
| session | create / join |
| invites | generate / use |
| run | start `POST /api/sessions/:id/runs` |
| run input | follow-up · interrupt |
| **event backfill** | `GET /api/sessions/:id/events?after=<cursor>` |
| **diff** | `GET /api/runs/:id/diff` (REST only) |
| changeset | approve · reject |
| files | tree · content read |

### Event backfill — `GET /api/sessions/:id/events?after=<cursor>`

Returns **`200`** with an **ordered array of Contract-1 event envelopes**, every element having
`id` **greater than** `<cursor>`, in **ascending `id`** order. The catch-up algorithm relies only
on the envelope cursor (`id`) and dedupe-by-`id` for durable events.

### Diffs are REST-only

A run's diff is fetched at `GET /api/runs/:id/diff`. **No diff payload is delivered over cable.**

## 3. Cable — `/~cable`, one envelope shape

- The ActionCable mount is **`/~cable`**.
- A client opens the realtime connection and **subscribes to the session channel**.
- **Every** broadcast is a Contract-1 envelope — **no custom cable message shapes**.
- The server **independently verifies participantship** before allowing a subscription (the
  client only hides buttons; the server enforces).

## 4. The 4-role permission matrix (server-enforced)

| action | owner | editor | reviewer | viewer |
|---|:---:|:---:|:---:|:---:|
| view / event backfill / read diffs & files | ✓ | ✓ | ✓ | ✓ |
| send `chat_message` | ✓ | ✓ | ✓ | ✓ |
| create / update tasks | ✓ | ✓ | ✓ | ✗ |
| start run / send follow-up / interrupt | ✓ | ✓ | ✗ | ✗ |
| approve / reject changeset | ✓ | ✗ | ✗ | ✗ |

(Per `docs/PLAN.md §9`: owner = everything incl. approve/reject; editor =
runs/follow-ups/interrupt/tasks/chat; reviewer = tasks/chat/view; viewer = view/chat.)

The server enforces this matrix on **every** endpoint; cable subscriptions independently verify
participantship. The client only hides buttons. A denied action for a **participant** returns
`403 { errors }` (§1); cross-session/unknown access returns `404`.

## 5. Authentication — one cookie for REST and cable

A role-scoped **reusable invite link** is exchanged for a **signed httpOnly cookie**
(`clawd_uid`), with **no `Secure` flag** on the plain-HTTP LAN. The **same cookie** authenticates
both REST requests and the ActionCable connection.

## 6. Gap-free late-joiner catch-up

The catch-up sequence (lives in `web/src/lib/cable.ts`):

1. **Subscribe** to the cable channel **first**.
2. **Buffer** live events as they arrive.
3. **Backfill** via `GET /api/sessions/:id/events?after=<cursor>`.
4. **Drain** the buffer: apply **durable** (non-null `id`) events only when `id` is **greater
   than the max backfilled `id`**; **always apply ephemeral (null-`id`) events** — a null `id` is
   not `> max`, so a literal filter would wrongly drop ephemeral events buffered during catch-up.
5. Go **live**.

Stores **dedupe durable events by `id`**; **ephemeral events (null `id`) are exempt** — deltas
accumulate by `(ai_run_id, block)`, presence is last-writer-wins per participant. The algorithm
relies only on the envelope cursor and dedupe-by-`id`; no missed or duplicated events.
