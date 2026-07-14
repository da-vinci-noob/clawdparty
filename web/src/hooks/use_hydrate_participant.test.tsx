import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../test/msw_server";
import { useParticipantStore } from "../stores/participant_store";
import { useHydrateParticipant } from "./use_hydrate_participant";

describe("useHydrateParticipant", () => {
  beforeEach(() => useParticipantStore.getState().clear());
  afterEach(() => useParticipantStore.getState().clear());

  it("hydrates the store from the server when empty (post-refresh)", async () => {
    server.use(
      http.get("/api/sessions/:id/participant", () =>
        HttpResponse.json(
          { id: "3", session_id: "42", role: "owner", name: "Alice" },
          { status: 200 },
        ),
      ),
    );
    renderHook(() => useHydrateParticipant("42"));

    await waitFor(() =>
      expect(useParticipantStore.getState().current).toMatchObject({
        role: "owner",
        session_id: "42",
      }),
    );
  });

  it("does not refetch when the store already has this session's participant", async () => {
    useParticipantStore
      .getState()
      .setCurrent({ id: "1", session_id: "42", role: "editor", name: "Me" });
    const spy = vi.fn(() => HttpResponse.json({ id: "x" }, { status: 200 }));
    server.use(http.get("/api/sessions/:id/participant", spy));

    renderHook(() => useHydrateParticipant("42"));
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(useParticipantStore.getState().current?.role).toBe("editor");
  });

  it("leaves the store empty when the server refuses (404)", async () => {
    server.use(
      http.get("/api/sessions/:id/participant", () => new HttpResponse(null, { status: 404 })),
    );
    renderHook(() => useHydrateParticipant("99"));
    await new Promise((r) => setTimeout(r, 20));
    expect(useParticipantStore.getState().current).toBeNull();
  });
});
