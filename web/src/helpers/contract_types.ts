// The cross-stream type seam: re-export the frozen event-envelope type from the
// contracts package so it resolves under tsc from web/. W1 consumes the contract
// ONLY as a type — no reducer, no cable.ts. The actual event handling lands in W2.

import type { EnvelopeType, EventEnvelope } from "@clawdparty/contracts";

export type { EventEnvelope, EnvelopeType };

// A typed placeholder proving the import compiles and is usable. Not wired to
// anything — replaced by the real reducer state in W2.
export type SessionEventLog = ReadonlyArray<EventEnvelope>;
