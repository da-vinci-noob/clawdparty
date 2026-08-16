// transport.ts — delivers normalized Contract-1 envelopes to Rails at
// POST /internal/events (bearer-authed). Two paths:
//  - DURABLE events: batched, ring-buffered, retried-with-backoff, idempotent on
//    (ai_run_id, seq). `seq` is assigned once at normalization and NEVER renumbered
//    on retry (renumbering would defeat the dedupe key).
//  - EPHEMERAL events (ai_text_delta/presence_changed, null seq): delivered
//    best-effort — never buffered, retried, or deduped. A dropped ephemeral is
//    acceptable; a never-sent one is not. Coalesced into ~150ms batches and sent
//    ONE AT A TIME, because ephemeral events carry no cursor to sort by (below).
//
// Response classification: 2xx -> ack+clear; 5xx/network -> transient, buffer+retry;
// 4xx (incl 401/403/404/422) -> FATAL, stop retrying, log, surface.

import type { EventEnvelope } from "@clawdparty/contracts";

/** Deltas accumulate this long before a batch goes out. Below the threshold where
 *  streaming stops reading as live, and enough to turn a token into a frame. */
const EPHEMERAL_FLUSH_MS = 150;

/** A hung POST must not stall the stream. Past this the batch is abandoned; the
 *  durable `ai_text` at block stop still carries the text. */
const EPHEMERAL_POST_TIMEOUT_MS = 5_000;

/** Only Rails being unreachable gets us near this. Deltas of one block coalesce into
 *  one entry, so the count grows with concurrent blocks, not with tokens. */
const EPHEMERAL_QUEUE_LIMIT = 2_000;

/**
 * The ephemeral types whose payload ACCUMULATES on the client rather than replacing.
 * Only these may be merged: `presence_changed` and `context_usage` are whole values
 * where the newest reading is the truth, and concatenating two of them is nonsense.
 */
const COALESCING_TYPES: ReadonlySet<string> = new Set(["ai_text_delta", "ai_thinking_delta"]);

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface TransportOptions {
  railsInternalUrl: string;
  sharedSecret: string;
  logger: Logger;
  maxBufferSize?: number;
  fetchImpl?: typeof fetch;
}

export type DeliveryOutcome = "acked" | "buffered" | "fatal";

export class Transport {
  private readonly buffer: EventEnvelope[] = [];
  private readonly maxBufferSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly ephemeralQueue: EventEnvelope[] = [];
  private ephemeralTimer: ReturnType<typeof setTimeout> | null = null;
  private ephemeralPump: Promise<void> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private fatal = false;

  constructor(private readonly opts: TransportOptions) {
    this.maxBufferSize = opts.maxBufferSize ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get bufferLength(): number {
    return this.buffer.length;
  }

  get isFatal(): boolean {
    return this.fatal;
  }

  // Structured logger for callers (e.g. the runner) to report run-drain errors.
  get logger(): Logger {
    return this.opts.logger;
  }

  // Durable delivery: try to POST the batch (plus anything already buffered). On
  // transient failure the events are retained for a later flush.
  async deliverDurable(events: EventEnvelope[]): Promise<DeliveryOutcome> {
    this.enqueue(events);
    return this.flush();
  }

  /**
   * Ephemeral delivery: best-effort, coalesced, and ORDERED. Never buffered/retried/deduped.
   *
   * Resolves on ENQUEUE, not on delivery — the timer or `flushEphemeral` sends it.
   *
   * Ordering is the reason this is not one unawaited POST per event. Ephemeral events carry
   * `seq: null` by contract, so the browser has no key to sort by and concatenates deltas in
   * ARRIVAL order; N racing POSTs over a network with any latency variance therefore
   * scrambled the words of a sentence. One request in flight at a time is what makes arrival
   * order equal emission order — coalescing alone would only make the scramble rarer, which
   * is worse, because a rare one reads as a model glitch rather than a bug.
   */
  deliverEphemeral(event: EventEnvelope): Promise<void> {
    this.enqueueEphemeral(event);
    this.scheduleEphemeralFlush();
    return Promise.resolve();
  }

  /** Send what is queued and wait for the queue to drain. For shutdown and tests —
   *  in production the timer delivers. */
  async flushEphemeral(): Promise<void> {
    if (this.ephemeralTimer !== null) {
      clearTimeout(this.ephemeralTimer);
      this.ephemeralTimer = null;
    }
    await this.pumpEphemeral();
  }

  /**
   * Append, merging into the LAST queued entry when it is the same stream.
   *
   * Last-entry-only, rather than scanning back for a match: merging into an earlier entry
   * would move text across whatever was queued in between. A block streams contiguously, so
   * this still merges nearly everything.
   */
  private enqueueEphemeral(event: EventEnvelope): void {
    const tail = this.ephemeralQueue.at(-1);
    if (tail && this.mergeable(tail, event)) {
      const tailText = (tail.payload as { text?: string }).text ?? "";
      const addition = (event.payload as { text?: string }).text ?? "";
      this.ephemeralQueue[this.ephemeralQueue.length - 1] = {
        ...event,
        payload: { ...(event.payload as object), text: tailText + addition },
      };
      return;
    }
    if (this.ephemeralQueue.length >= EPHEMERAL_QUEUE_LIMIT) {
      this.ephemeralQueue.shift();
      this.opts.logger.warn(
        { limit: EPHEMERAL_QUEUE_LIMIT },
        "ephemeral queue full: dropping oldest (live text will skip; durable record unaffected)",
      );
    }
    this.ephemeralQueue.push(event);
  }

  private mergeable(tail: EventEnvelope, next: EventEnvelope): boolean {
    return (
      tail.type === next.type &&
      COALESCING_TYPES.has(next.type) &&
      tail.session_id === next.session_id &&
      tail.ai_run_id === next.ai_run_id &&
      (tail.payload as { block?: string }).block === (next.payload as { block?: string }).block
    );
  }

  private scheduleEphemeralFlush(): void {
    if (this.ephemeralTimer !== null) return;
    const timer = setTimeout(() => {
      this.ephemeralTimer = null;
      void this.pumpEphemeral();
    }, EPHEMERAL_FLUSH_MS);
    timer.unref?.();
    this.ephemeralTimer = timer;
  }

  /**
   * Drain the queue, ONE POST at a time. Single-flight is both the ordering guarantee and
   * the backpressure: events arriving while a POST is outstanding land in the queue and go
   * out as the next batch, so a slow Rails produces bigger batches rather than a growing
   * pile of pending requests.
   */
  private pumpEphemeral(): Promise<void> {
    this.ephemeralPump ??= this.drainEphemeral().finally(() => {
      this.ephemeralPump = null;
    });
    return this.ephemeralPump;
  }

  private async drainEphemeral(): Promise<void> {
    while (this.ephemeralQueue.length > 0) {
      const batch = this.ephemeralQueue.splice(0, this.ephemeralQueue.length);
      try {
        await this.postEphemeral(batch);
      } catch {
        // Dropped, by design. Retrying would deliver a delta after the block it belongs to
        // had already settled from `ai_text`.
      }
    }
  }

  private async postEphemeral(batch: EventEnvelope[]): Promise<void> {
    const posting = this.post(batch);
    // The race below can abandon this promise; a rejection with no handler attached would
    // surface as an unhandledRejection and take the harness down.
    posting.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("ephemeral POST timed out")),
        EPHEMERAL_POST_TIMEOUT_MS,
      );
      timer.unref?.();
    });

    try {
      await Promise.race([posting, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Re-POST whatever is buffered. Idempotent: Rails skips duplicate (ai_run_id, seq).
   *
   * SERIALIZED, because the ack does `splice(0, batch.length)` — which is only correct while
   * the buffer's head is still the batch that was sent. `deliverDurable` is called unawaited
   * from `supervisor.ship()`, so two flushes overlapped every turn, and an older ack could
   * splice out a NEWER event whose own POST had failed and was relying on the buffer for its
   * retry. That event was then neither sent nor buffered, with nothing logged.
   */
  flush(): Promise<DeliveryOutcome> {
    const result = this.flushChain.then(
      () => this.flushOnce(),
      () => this.flushOnce(),
    );
    this.flushChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async flushOnce(): Promise<DeliveryOutcome> {
    if (this.fatal || this.buffer.length === 0) {
      return this.fatal ? "fatal" : "acked";
    }
    const batch = this.buffer.slice();
    try {
      const status = await this.post(batch);
      if (status >= 200 && status < 300) {
        this.buffer.splice(0, batch.length); // ack: clear exactly what we sent
        return "acked";
      }
      if (status >= 500) {
        this.opts.logger.warn({ status }, "transient /internal/events failure; will retry");
        return "buffered";
      }
      // 4xx (401/403/404/422 and any other) — non-transient misconfiguration.
      this.fatal = true;
      this.opts.logger.error({ status }, this.fatalMessage(status));
      return "fatal";
    } catch (err) {
      // Network error — transient. Keep events buffered for retry.
      this.opts.logger.warn({ err: String(err) }, "network error to Rails; will retry");
      return "buffered";
    }
  }

  private enqueue(events: EventEnvelope[]): void {
    for (const event of events) {
      if (this.buffer.length >= this.maxBufferSize) {
        const dropped = this.buffer.shift(); // evict OLDEST
        this.opts.logger.error(
          { dropped_seq: dropped?.seq, dropped_run: dropped?.ai_run_id },
          "ring buffer overflow: evicting oldest unsent event (data loss)",
        );
      }
      this.buffer.push(event);
    }
  }

  private async post(events: EventEnvelope[]): Promise<number> {
    const res = await this.fetchImpl(`${this.opts.railsInternalUrl}/internal/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.sharedSecret}`,
      },
      body: JSON.stringify({ events }), // frozen { events: [...] } shape, never a bare array
    });
    return res.status;
  }

  private fatalMessage(status: number): string {
    if (status === 401) return "FATAL: /internal/events 401 — bad/missing HARNESS_SHARED_SECRET";
    if (status === 403) return "FATAL: /internal/events 403 — forbidden (misconfiguration)";
    if (status === 404)
      return "FATAL: /internal/events 404 — callback endpoint not found/misrouted";
    if (status === 422) return "FATAL: /internal/events 422 — malformed batch";
    return `FATAL: /internal/events ${status} — non-transient request error`;
  }
}
