// cable.ts — the SINGLE owner of the gap-free late-joiner catch-up algorithm
// (frozen http-api-contract). The sequence:
//   1. subscribe to the session channel FIRST and buffer live events;
//   2. REST-backfill GET /api/sessions/:id/events?after=<cursor>;
//   3. drain the buffer: apply DURABLE (non-null id) events only when id > the
//      max backfilled id, while ALWAYS applying EPHEMERAL (null-id) events
//      (a null id is never > max, so a literal filter would wrongly drop them);
//   4. go live (pass-through).
// Ordering relies ONLY on the global `id` cursor + dedupe-by-id for durable
// events — never on `seq` or `ts`. Reconnect re-runs ONLY backfill+drain from the
// store's max applied durable id (the subscription is created once); dedupe-by-id
// makes the re-drain idempotent.

import type { EventEnvelope } from "@clawdparty/contracts";

// A minimal channel abstraction so the catch-up logic is testable with a fake
// (no real WebSocket). A real subscription (action_cable_provider) adapts to this.
export interface SessionChannel {
  // Register the live-event handler and subscribe. Returns an unsubscribe fn.
  subscribe: (onEvent: (event: EventEnvelope) => void) => () => void;
}

export interface CatchUpDeps {
  channel: SessionChannel;
  // REST backfill: ordered ascending-id envelopes with id > cursor, scoped to the session.
  backfill: (afterId: number) => Promise<EventEnvelope[]>;
  // Apply an event to the store (durable dedupe-by-id lives in the store).
  apply: (event: EventEnvelope) => void;
  // The store's current max applied durable id (0 on a fresh join). Read lazily.
  maxAppliedId: () => number;
}

export interface CatchUpHandle {
  stop: () => void;
}

// Backfill from the current cursor, then drain the buffer. Reusable for the
// initial catch-up AND for reconnect (re-run without re-subscribing). Durable
// events from the buffer apply only when id > maxBackfilledId; ephemeral
// (null-id) events are ALWAYS applied (exempt from the id filter).
async function backfillAndDrain(
  deps: Pick<CatchUpDeps, "backfill" | "apply" | "maxAppliedId">,
  buffer: EventEnvelope[],
): Promise<void> {
  const cursor = deps.maxAppliedId();
  const backfilled = await deps.backfill(cursor);
  let maxBackfilledId = cursor;
  for (const event of backfilled) {
    deps.apply(event);
    if (event.id !== null && event.id > maxBackfilledId) {
      maxBackfilledId = event.id;
    }
  }
  for (const event of buffer) {
    if (event.id === null || event.id > maxBackfilledId) {
      deps.apply(event);
    }
    // else: a durable event backfill already returned — dedupe-by-id would no-op it.
  }
  buffer.length = 0;
}

// Run the gap-free catch-up once. Subscribes FIRST, buffers, backfills, drains,
// goes live. Returns a handle to stop the live subscription. This is the unit-
// tested entry point; the hook uses CableController for reconnect handling.
export async function startCatchUp(deps: CatchUpDeps): Promise<CatchUpHandle> {
  const buffer: EventEnvelope[] = [];
  let live = false;
  const unsubscribe = deps.channel.subscribe((event) => {
    if (live) {
      deps.apply(event);
    } else {
      buffer.push(event);
    }
  });
  await backfillAndDrain(deps, buffer);
  live = true;
  return { stop: unsubscribe };
}

// Controller for the real hook: creates the channel subscription ONCE and
// re-runs backfill+drain on reconnect (without re-subscribing). Between a
// reconnect signal and drain completion, live events are buffered again.
export class CableController {
  private buffer: EventEnvelope[] = [];
  private live = false;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: CatchUpDeps) {}

  // Create the subscription once. The onEvent router buffers while catching up
  // and applies once live.
  start(): void {
    this.unsubscribe = this.deps.channel.subscribe((event) => {
      if (this.live) {
        this.deps.apply(event);
      } else {
        this.buffer.push(event);
      }
    });
    void this.catchUp();
  }

  // (Re-)run backfill+drain from the current cursor. Called initially and on each
  // reconnect. Sets live=false while draining so concurrent events are buffered.
  async catchUp(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.live = false;
    await backfillAndDrain(this.deps, this.buffer);
    if (!this.stopped) {
      this.live = true;
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
  }
}
