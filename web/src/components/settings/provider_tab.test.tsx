import type { ProviderStatus } from "@clawdparty/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { type Role, useParticipantStore } from "../../stores/participant_store";
import { ProviderTab } from "./provider_tab";

/**
 * The per-session defaults.
 *
 * They are DEFAULTS, not locks: the composer's per-run pick still wins, and what this removes is
 * re-choosing the same model every run. Two rules carry the weight:
 *
 *   * models are offered BY PROVIDER, because a model id only means something relative to the
 *     provider serving it — and the server refuses a mismatched pair, so offering one would be a
 *     guaranteed 422;
 *   * the AWS profile decides WHOSE ACCOUNT PAYS , so it is owner-only and says so.
 */

const CAPS = {
  streaming: true as const,
  toolUse: true,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  adaptiveThinking: false,
  thinkingBudgetTokens: null,
  thinkingDisplaySummarized: false,
  effortLevels: [],
  promptCaching: false,
  minCacheablePrefixTokens: null,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: false, webFetch: false, codeExecution: false },
  liveModelDiscovery: true,
  serverSideRefusalFallback: false,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

const PROVIDERS: ProviderStatus[] = [
  {
    id: "anthropic-bedrock",
    displayName: "Amazon Bedrock",
    available: true,
    models: [
      { id: "global.anthropic.claude-sonnet-4-6", displayName: "Sonnet 4.6", capabilities: CAPS },
    ],
  },
  {
    id: "bedrock-converse",
    displayName: "Bedrock (Converse)",
    available: true,
    models: [{ id: "us.deepseek.r1-v1:0", displayName: "DeepSeek R1", capabilities: CAPS }],
  },
];

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

function stub(session: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/models", () => HttpResponse.json({ providers: PROVIDERS })),
    http.get("/api/aws-profiles", () =>
      HttpResponse.json({ profiles: ["claude-code-sso", "default"], source: "host" }),
    ),
    http.get("/api/sessions/:id", () =>
      HttpResponse.json({ id: "s", mode: "chat", repository_path: "/repo", ...session }),
    ),
  );
}

/** What the browser actually PATCHed — the only proof a default was really saved. */
function capturePatch(): { last: () => Record<string, unknown> | null } {
  let body: Record<string, unknown> | null = null;
  server.use(
    http.patch("/api/sessions/:id", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "s", mode: "chat", repository_path: "/repo", ...body });
    }),
  );
  return { last: () => body };
}

beforeEach(() => {
  useParticipantStore.getState().clear();
  stub();
});
afterEach(() => {
  server.resetHandlers();
  useParticipantStore.getState().clear();
});

describe("what is shown", () => {
  it("seeds the controls from the session's stored defaults", async () => {
    stub({
      default_provider: "anthropic-bedrock",
      default_model: "global.anthropic.claude-sonnet-4-6",
      aws_profile: "claude-code-sso",
    });
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    await waitFor(() =>
      expect(screen.getByTestId("default-provider")).toHaveValue("anthropic-bedrock"),
    );
    expect(screen.getByTestId("default-model")).toHaveValue("global.anthropic.claude-sonnet-4-6");
    expect(screen.getByTestId("aws-profile")).toHaveValue("claude-code-sso");
  });

  it("offers 'no default' so a session can go back to server resolution", async () => {
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    const options = await waitFor(() =>
      Array.from(screen.getByTestId("default-provider").querySelectorAll("option")).map(
        (o) => o.textContent,
      ),
    );
    expect(options[0]).toMatch(/no default/i);
  });

  it("says what the AWS profile decides, where it is chosen", async () => {
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    expect(await screen.findByTestId("aws-profile-note")).toHaveTextContent(/which AWS account/i);
  });
});

describe("models are scoped to the provider", () => {
  it("offers only the chosen provider's models", async () => {
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("default-provider"), {
      target: { value: "bedrock-converse" },
    });

    const models = Array.from(screen.getByTestId("default-model").querySelectorAll("option")).map(
      (o) => o.getAttribute("value"),
    );
    // Offering Sonnet under Converse would be offering a pair the server refuses.
    expect(models).toContain("us.deepseek.r1-v1:0");
    expect(models).not.toContain("global.anthropic.claude-sonnet-4-6");
  });

  it("clears the model when the provider changes", async () => {
    stub({
      default_provider: "anthropic-bedrock",
      default_model: "global.anthropic.claude-sonnet-4-6",
    });
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    await waitFor(() =>
      expect(screen.getByTestId("default-model")).toHaveValue("global.anthropic.claude-sonnet-4-6"),
    );
    fireEvent.change(screen.getByTestId("default-provider"), {
      target: { value: "bedrock-converse" },
    });

    // Keeping the old model is the exact mismatch the server rejects, and it would look like the
    // form saved something it did not.
    expect(screen.getByTestId("default-model")).toHaveValue("");
  });

  it("disables the model select until a provider is chosen", async () => {
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    expect(await screen.findByTestId("default-model")).toBeDisabled();
  });
});

describe("saving", () => {
  it("PATCHes exactly the three defaults, and no working directory", async () => {
    const captured = capturePatch();
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    fireEvent.change(await screen.findByTestId("default-provider"), {
      target: { value: "anthropic-bedrock" },
    });
    fireEvent.change(screen.getByTestId("default-model"), {
      target: { value: "global.anthropic.claude-sonnet-4-6" },
    });
    fireEvent.change(screen.getByTestId("aws-profile"), { target: { value: "claude-code-sso" } });
    fireEvent.click(screen.getByTestId("provider-save"));

    await waitFor(() => expect(captured.last()).not.toBeNull());
    // `repository_path` absent is load-bearing: the endpoint recomputes the working directory when
    // that key is present, and would move it to the repo root.
    expect(captured.last()).toEqual({
      default_provider: "anthropic-bedrock",
      default_model: "global.anthropic.claude-sonnet-4-6",
      aws_profile: "claude-code-sso",
    });
  });

  it("confirms what the save means", async () => {
    capturePatch();
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId("provider-save"));
    expect(await screen.findByTestId("provider-saved")).toHaveTextContent(/next run/i);
  });

  it("surfaces the server's refusal verbatim", async () => {
    server.use(
      http.patch("/api/sessions/:id", () =>
        HttpResponse.json(
          { errors: [{ message: "anthropic-bedrock does not serve model us.deepseek.r1-v1:0" }] },
          { status: 422 },
        ),
      ),
    );
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    fireEvent.click(await screen.findByTestId("provider-save"));
    expect(await screen.findByTestId("provider-error")).toHaveTextContent(/does not serve model/);
  });
});

describe("a non-owner", () => {
  for (const role of ["editor", "reviewer", "viewer"] as const) {
    it(`shows a ${role} the values but no way to change them`, async () => {
      stub({ default_provider: "anthropic-bedrock", aws_profile: "claude-code-sso" });
      setRole(role);
      renderWithQuery(<ProviderTab sessionId="s" />);

      // Readable by everyone: which account a run bills is a fact about the room, not an owner
      // secret. Only the writing is gated.
      await waitFor(() =>
        expect(screen.getByTestId("default-provider")).toHaveValue("anthropic-bedrock"),
      );
      expect(screen.getByTestId("default-provider")).toBeDisabled();
      expect(screen.getByTestId("aws-profile")).toBeDisabled();
      expect(screen.queryByTestId("provider-save")).not.toBeInTheDocument();
      expect(screen.getByTestId("provider-read-only")).toHaveTextContent(/owner/i);
    });
  }
});

describe("when the harness is down", () => {
  it("still renders, with nothing to offer", async () => {
    server.use(
      http.get("/api/models", () => new HttpResponse(null, { status: 502 })),
      http.get("/api/aws-profiles", () => new HttpResponse(null, { status: 502 })),
      http.get("/api/sessions/:id", () =>
        HttpResponse.json({ id: "s", mode: "chat", repository_path: "/repo" }),
      ),
    );
    setRole("owner");
    renderWithQuery(<ProviderTab sessionId="s" />);

    // A settings tab that throws on a 502 is worse than one that shows an empty list.
    expect(await screen.findByTestId("provider-form")).toBeInTheDocument();
    expect(screen.getByTestId("aws-profile").querySelectorAll("option")).toHaveLength(1);
  });
});
