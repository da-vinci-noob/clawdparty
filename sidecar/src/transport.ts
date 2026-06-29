// transport.ts — delivers normalized Contract-1 envelopes to Rails at
// POST /internal/events (bearer-authed). Two paths:
//  - DURABLE events: batched, ring-buffered, retried-with-backoff, idempotent on
//    (ai_run_id, seq). `seq` is assigned once at normalization and NEVER renumbered
//    on retry (renumbering would defeat the dedupe key).
//  - EPHEMERAL events (ai_text_delta/presence_changed, null seq): delivered
//    best-effort fire-and-forget — never buffered, retried, or deduped. A dropped
//    ephemeral is acceptable; a never-sent one is not.
//
// Response classification: 2xx -> ack+clear; 5xx/network -> transient, buffer+retry;
// 4xx (incl 401/403/404/422) -> FATAL, stop retrying, log, surface.

import type { EventEnvelope } from "@clawdparty/contracts";

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

  // Durable delivery: try to POST the batch (plus anything already buffered). On
  // transient failure the events are retained for a later flush.
  async deliverDurable(events: EventEnvelope[]): Promise<DeliveryOutcome> {
    this.enqueue(events);
    return this.flush();
  }

  // Ephemeral delivery: best-effort, fire-and-forget. Never buffered/retried/deduped.
  async deliverEphemeral(event: EventEnvelope): Promise<void> {
    try {
      await this.post([event]);
    } catch {
      // A dropped ephemeral is acceptable — the durable ai_text block-stop record
      // is the source of truth. Do not buffer or retry.
    }
  }

  // Re-POST whatever is buffered. Idempotent: Rails skips duplicate (ai_run_id, seq).
  async flush(): Promise<DeliveryOutcome> {
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
    if (status === 401) return "FATAL: /internal/events 401 — bad/missing SIDECAR_SHARED_SECRET";
    if (status === 403) return "FATAL: /internal/events 403 — forbidden (misconfiguration)";
    if (status === 404)
      return "FATAL: /internal/events 404 — callback endpoint not found/misrouted";
    if (status === 422) return "FATAL: /internal/events 422 — malformed batch";
    return `FATAL: /internal/events ${status} — non-transient request error`;
  }
}
