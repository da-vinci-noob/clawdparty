import type { EventEnvelope } from "@clawdparty/contracts";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { FC, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFakeConsumer } from "../../test/fake_consumer";
import { server } from "../../test/msw_server";
import { ActionCableProvider } from "../lib/action_cable_provider";
import { useEventStore } from "../stores/event_store";
import { useSessionEvents } from "./use_session_events";

function durable(id: number, sessionId: string): EventEnvelope {
  return {
    id,
    session_id: sessionId,
    ai_run_id: null,
    seq: id,
    type: "chat_message",
    actor: { kind: "user", id: "u1" },
    ts: "2026-07-17T00:00:00Z",
    payload: { text: `msg ${id}` },
  } as unknown as EventEnvelope;
}

function wrapper(): FC<{ children: ReactNode }> {
  const { consumer } = makeFakeConsumer();
  return ({ children }) => (
    <ActionCableProvider consumerFactory={() => consumer}>{children}</ActionCableProvider>
  );
}

describe("useSessionEvents", () => {
  beforeEach(() => useEventStore.getState().reset());
  afterEach(() => useEventStore.getState().reset());

  it("backfills the full history from cursor 0 on a fresh mount", async () => {
    server.use(
      http.get("/api/sessions/:id/events", ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        expect(after).toBe("0");
        return HttpResponse.json([durable(1, "a"), durable(2, "a")]);
      }),
    );

    renderHook(() => useSessionEvents("a"), { wrapper: wrapper() });

    await waitFor(() => expect(useEventStore.getState().durableList).toHaveLength(2));
  });

  it("resets the store when the session changes, so the next backfill starts from 0", async () => {
    // Simulate a prior session having left durable events + a high cursor behind
    // (as client-side navigation via the session list would). Without a reset the
    // next backfill would request `after=<that high id>` and get nothing.
    useEventStore.getState().apply(durable(1500, "a"));
    expect(useEventStore.getState().maxAppliedId).toBe(1500);

    let requestedAfter: string | null = null;
    server.use(
      http.get("/api/sessions/:id/events", ({ request }) => {
        requestedAfter = new URL(request.url).searchParams.get("after");
        return HttpResponse.json([durable(3, "b"), durable(4, "b")]);
      }),
    );

    renderHook(() => useSessionEvents("b"), { wrapper: wrapper() });

    // Cursor was reset to 0 before backfill, so session b's full history is fetched
    // and session a's stale events are gone.
    await waitFor(() => expect(requestedAfter).toBe("0"));
    await waitFor(() => {
      const ids = useEventStore.getState().durableList.map((e) => e.id);
      expect(ids).toEqual([3, 4]);
    });
  });
});
