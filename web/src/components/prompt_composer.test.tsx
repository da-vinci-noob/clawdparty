import { BUILTIN_TOOL_IDS } from "@clawdparty/contracts";
import type { ProviderStatus } from "@clawdparty/contracts";
import type { EventEnvelope } from "@clawdparty/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "../../test/msw_server";
import { renderWithQuery as renderComposer } from "../../test/render_with_query";
import { useEventStore } from "../stores/event_store";
import { type Role, useParticipantStore } from "../stores/participant_store";
import { PromptComposer } from "./prompt_composer";

function setRole(role: Role) {
  useParticipantStore.getState().setCurrent({ id: "1", session_id: "s", role, name: "Me" });
}

// Capture the body of the last POST to run start.
function captureRunStart(): { last: () => Record<string, unknown> | null } {
  let body: Record<string, unknown> | null = null;
  server.use(
    http.post("/api/sessions/:id/runs", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "run9", status: "queued" }, { status: 202 });
    }),
  );
  return { last: () => body };
}

function planRunFinished() {
  const started: EventEnvelope = {
    id: 1,
    session_id: "s",
    ai_run_id: "run1",
    seq: 2,
    type: "run_started",
    actor: { kind: "user", id: "1" },
    ts: "2026-07-17T00:00:00.000Z",
    payload: { model: "m", cwd: "/r" },
  };
  const finished: EventEnvelope = {
    ...started,
    id: 2,
    seq: 9,
    type: "run_finished",
    actor: { kind: "claude" },
    payload: {},
  };
  useEventStore.getState().applyMany([started, finished]);
}

/**
 * A `/api/models` response in the REAL contract shape.
 *
 * TYPED against `ProviderStatus` on purpose. These mocks previously hand-wrote
 * `{ source, models }` — the pre-harness shape — so they kept passing after the server moved
 * to `{ providers }` and the picker was silently broken in production while this suite was
 * green. A typed fixture makes the next shape change a compile error here.
 */
function providersResponse(
  models: Array<{ id: string; label: string; window?: number }>,
  over: Partial<ProviderStatus> = {},
): { providers: ProviderStatus[] } {
  return {
    providers: [
      {
        id: "anthropic-direct",
        displayName: "Anthropic (direct)",
        available: true,
        credentialSource: "env:ANTHROPIC_API_KEY",
        models: models.map((m) => ({
          id: m.id,
          displayName: m.label,
          capabilities: { ...MODEL_CAPS, contextWindow: m.window ?? 200_000 },
        })),
        ...over,
      },
    ],
  };
}

const MODEL_CAPS = {
  streaming: true as const,
  toolUse: true as const,
  toolUseWhileStreaming: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  adaptiveThinking: true,
  thinkingDisplaySummarized: true,
  effortLevels: [],
  promptCaching: true,
  minCacheablePrefixTokens: 512,
  serverSideCompaction: false,
  contextEditing: false,
  serverSideTools: { webSearch: true, webFetch: true, codeExecution: true },
  liveModelDiscovery: true,
  serverSideRefusalFallback: true,
  midConversationSystemMessages: true,
  midConversationToolChanges: true,
};

describe("PromptComposer permission modes", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  it("is not rendered for a viewer (no run permission)", () => {
    setRole("viewer");
    renderComposer(<PromptComposer sessionId="s" />);
    expect(screen.queryByTestId("prompt-composer")).not.toBeInTheDocument();
  });

  // The four permission-mode tests went with the parameter (CHANGELOG B2). These
  // two replace them by asserting the ABSENCE, because a removed control that
  // nothing tests is a control that quietly comes back.
  it("renders no permission-mode selector and no Execute-plan shortcut", () => {
    setRole("owner");
    planRunFinished();
    renderComposer(<PromptComposer sessionId="s" />);

    expect(screen.queryByTestId("permission-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execute-plan")).not.toBeInTheDocument();
  });

  it("does not send permission_mode on run start", async () => {
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ prompt: "do the thing" });
    // Rails no longer accepts it; sending it would be a 422 in production.
    expect(cap.last()).not.toHaveProperty("permission_mode");
  });

  it("populates the model dropdown from GET /api/models and sends the chosen model", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json(
          providersResponse([{ id: "us.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" }], {
            id: "anthropic-bedrock",
            displayName: "Amazon Bedrock",
            credentialSource: "env:AWS_PROFILE",
          }),
        ),
      ),
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // The discovered Bedrock model appears once the query resolves.
    await screen.findByRole("option", { name: "Bedrock Opus 4.8" });

    fireEvent.change(screen.getByTestId("model"), {
      target: { value: "us.anthropic.claude-opus-4-8" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ model: "us.anthropic.claude-opus-4-8" });
  });

  it("sends the PROVIDER that listed the chosen model, not just the model id", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json({
          providers: [
            providersResponse([{ id: "claude-opus-5", label: "Opus 5" }]).providers[0],
            providersResponse([{ id: "anthropic.claude-opus-5", label: "Opus 5 (Bedrock)" }], {
              id: "anthropic-bedrock",
              displayName: "Amazon Bedrock",
              credentialSource: "env:AWS_PROFILE",
            }).providers[0],
          ],
        }),
      ),
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    await waitFor(() =>
      expect(screen.getByTestId("model").querySelectorAll("option")).toHaveLength(3),
    );
    fireEvent.change(screen.getByTestId("model"), {
      target: { value: "anthropic.claude-opus-5" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Message the room/), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // A model id only means something relative to the provider that listed it. Without this
    // the server fell back to `anthropic-direct`, which REJECTS a Bedrock inference-profile
    // id — so picking a Bedrock model produced a run that died at dispatch.
    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({
      model: "anthropic.claude-opus-5",
      provider: "anthropic-bedrock",
    });
  });

  it("sends NO provider when no model is chosen, leaving the server to resolve", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json(providersResponse([{ id: "claude-opus-5", label: "Opus 5" }])),
      ),
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByPlaceholderText(/Message the room/), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // "Default model" must not pin a provider either — `Runs::ResolveModel` picks one the
    // host can actually serve, and a stale provider here would defeat that.
    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).not.toHaveProperty("provider");
    expect(cap.last()).not.toHaveProperty("model");
  });

  it("GROUPS the options by provider, so a participant sees whose account they spend", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json({
          providers: [
            providersResponse([{ id: "claude-opus-5", label: "Opus 5" }]).providers[0],
            providersResponse([{ id: "anthropic.claude-opus-5", label: "Opus 5 (Bedrock)" }], {
              id: "anthropic-bedrock",
              displayName: "Amazon Bedrock",
            }).providers[0],
          ],
        }),
      ),
    );
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // "Claude Opus 5" appears under two providers and bills different accounts ;
    // a flat list of ids cannot express that.
    await waitFor(() =>
      expect(
        Array.from(screen.getByTestId("model").querySelectorAll("optgroup")).map((g) =>
          g.getAttribute("label"),
        ),
      ).toEqual(["Anthropic (direct)", "Amazon Bedrock"]),
    );
  });

  it("MARKS a streaming-limited model as tools-without-live-streaming", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json({
          providers: [
            {
              ...providersResponse(
                [{ id: "us.meta.llama3-3-70b-instruct-v1:0", label: "Llama 3.3 70B" }],
                {
                  id: "bedrock-converse",
                  displayName: "Amazon Bedrock (Converse)",
                },
              ).providers[0],
              models: [
                {
                  id: "us.meta.llama3-3-70b-instruct-v1:0",
                  displayName: "Llama 3.3 70B",
                  capabilities: { ...MODEL_CAPS, toolUseWhileStreaming: false },
                },
              ],
            },
          ],
        }),
      ),
    );
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // Measured on Bedrock: 8 of 18 non-Anthropic models reject a toolConfig on a STREAMING
    // request but accept it on non-streaming Converse. The adapter falls back, so a
    // tools turn works — the only cost is no live token streaming, which the label states so
    // the pause reads as expected rather than the product being broken.
    const option = await waitFor(() => {
      const el = screen
        .getByTestId("model")
        .querySelector('option[value="us.meta.llama3-3-70b-instruct-v1:0"]');
      if (!el) throw new Error("option not rendered yet");
      return el;
    });
    expect(option.textContent).toMatch(/no live streaming/i);
  });

  it("does NOT mark a model whose capability is simply capable", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json(providersResponse([{ id: "claude-opus-5", label: "Opus 5" }])),
      ),
    );
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    const option = await waitFor(() => {
      const el = screen.getByTestId("model").querySelector('option[value="claude-opus-5"]');
      if (!el) throw new Error("not yet");
      return el;
    });
    expect(option.textContent).toBe("Opus 5");
  });

  it("does NOT mark a model when the field is ABSENT (older harness), only when it is false", async () => {
    // Version skew, observed live: a harness on pre-1.6 code serves capabilities with no
    // `toolUseWhileStreaming` at all. Treating missing as `false` labelled EVERY Anthropic
    // model "no tools while streaming" — alarming and wrong, since Anthropic does both. The
    // label is a warning about a KNOWN limit, so only an explicit `false` earns it.
    server.use(
      http.get("/api/models", () => {
        const body = providersResponse([{ id: "claude-opus-5", label: "Opus 5" }]);
        for (const m of body.providers[0]?.models ?? []) {
          // `undefined` rather than `delete`: JSON.stringify omits the key, so the response body
          // on the wire is the pre-1.6 shape this asserts against.
          (m.capabilities as { toolUseWhileStreaming?: boolean }).toolUseWhileStreaming = undefined;
        }
        return HttpResponse.json(body);
      }),
    );
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    const option = await waitFor(() => {
      const el = screen.getByTestId("model").querySelector('option[value="claude-opus-5"]');
      if (!el) throw new Error("not yet");
      return el;
    });
    expect(option.textContent).toBe("Opus 5");
  });

  describe("a model that cannot use tools at all", () => {
    const noToolsModels = () => ({
      providers: [
        {
          ...providersResponse([], {
            id: "bedrock-converse",
            displayName: "Amazon Bedrock (Converse)",
          }).providers[0],
          models: [
            {
              id: "us.deepseek.r1-v1:0",
              displayName: "DeepSeek R1",
              capabilities: { ...MODEL_CAPS, toolUse: false, toolUseWhileStreaming: false },
            },
          ],
        },
      ],
    });

    async function pickDeepSeek() {
      setRole("owner");
      renderComposer(<PromptComposer sessionId="s" />);
      const option = await waitFor(() => {
        const el = screen.getByTestId("model").querySelector('option[value="us.deepseek.r1-v1:0"]');
        if (!el) throw new Error("option not rendered yet");
        return el;
      });
      fireEvent.change(screen.getByTestId("model"), { target: { value: "us.deepseek.r1-v1:0" } });
      return option;
    }

    beforeEach(() => {
      server.use(http.get("/api/models", () => HttpResponse.json(noToolsModels())));
    });

    it("is OFFERED, labelled as answering only", async () => {
      // It used to be missing from the picker entirely, which is indistinguishable from the host
      // not having Bedrock access. A limit stated is a limit a participant can work with.
      const option = await pickDeepSeek();
      expect(option.textContent).toMatch(/no tools/i);
      expect(option.textContent).toMatch(/answers only/i);
    });

    it("starts the run with every built-in tool disallowed", async () => {
      // The harness REFUSES a run that offers tools to such a model (there is no transport that
      // works), so the composer has to declare none — otherwise selecting it always fails.
      const cap = captureRunStart();
      await pickDeepSeek();
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "why is 17*3 51?" } });
      fireEvent.submit(screen.getByTestId("prompt-composer"));

      await waitFor(() => expect(cap.last()).not.toBeNull());
      expect(cap.last()?.disallowed_tools).toEqual([...BUILTIN_TOOL_IDS]);
    });

    it("does not disallow anything for a tool-capable model", async () => {
      server.use(
        http.get("/api/models", () =>
          HttpResponse.json(providersResponse([{ id: "claude-opus-5", label: "Opus 5" }])),
        ),
      );
      const cap = captureRunStart();
      setRole("owner");
      renderComposer(<PromptComposer sessionId="s" />);
      await waitFor(() => {
        if (!screen.getByTestId("model").querySelector('option[value="claude-opus-5"]')) {
          throw new Error("not yet");
        }
      });
      fireEvent.change(screen.getByTestId("model"), { target: { value: "claude-opus-5" } });
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello" } });
      fireEvent.submit(screen.getByTestId("prompt-composer"));

      await waitFor(() => expect(cap.last()).not.toBeNull());
      expect(cap.last()).not.toHaveProperty("disallowed_tools");
    });

    it("treats an ABSENT toolUse as capable, not as no-tools", async () => {
      // Version skew again: a pre-1.8 harness omits the field. Reading absent as `false` would
      // strip every tool from a model that has them — the mirror of the v1.6 mistake, and worse,
      // because it would break working models rather than just mislabel them.
      server.use(
        http.get("/api/models", () => {
          const body = providersResponse([{ id: "claude-opus-5", label: "Opus 5" }]);
          for (const m of body.providers[0]?.models ?? []) {
            (m.capabilities as { toolUse?: boolean }).toolUse = undefined;
          }
          return HttpResponse.json(body);
        }),
      );
      const cap = captureRunStart();
      setRole("owner");
      renderComposer(<PromptComposer sessionId="s" />);
      const option = await waitFor(() => {
        const el = screen.getByTestId("model").querySelector('option[value="claude-opus-5"]');
        if (!el) throw new Error("not yet");
        return el;
      });
      expect(option.textContent).toBe("Opus 5");

      fireEvent.change(screen.getByTestId("model"), { target: { value: "claude-opus-5" } });
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello" } });
      fireEvent.submit(screen.getByTestId("prompt-composer"));
      await waitFor(() => expect(cap.last()).not.toBeNull());
      expect(cap.last()).not.toHaveProperty("disallowed_tools");
    });
  });

  it("offers only 'Default model' until discovery resolves (no invalid fallback ids)", () => {
    // No /api/models mock → discovery hasn't produced host-valid ids yet. The picker
    // must NOT offer hardcoded plain-id fallbacks (they're invalid on Bedrock); only
    // "Default model" (the server's configured model) is safe until the real list loads.
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);
    const options = Array.from(screen.getByTestId("model").querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Default model"]);
  });

  it("omits model on run start when left on Default", async () => {
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).not.toHaveProperty("model");
  });
});

describe("PromptComposer capability selection", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  function discovery(connectors: unknown[], skills: unknown[]): void {
    server.use(
      http.get("/api/sessions/:id/connectors", () =>
        HttpResponse.json({ connectors, source: connectors.length ? "project" : "unavailable" }),
      ),
      http.get("/api/sessions/:id/skills", () =>
        HttpResponse.json({ skills, source: skills.length ? "project" : "unavailable" }),
      ),
    );
  }

  it("hides the Skills control for a reviewer (no run permission)", () => {
    setRole("reviewer");
    renderComposer(<PromptComposer sessionId="s" />);
    expect(screen.queryByTestId("skills-toggle")).not.toBeInTheDocument();
  });

  it("enables all skills but NO connectors by default", async () => {
    // Connectors used to be auto-enabled, which was free while the harness ignored them. With a
    // real MCP client it is not: measured on this host, all 8 servers declare 77 tools and
    // ~37,500 tokens of schema, spent on every turn. So they are opt-in; skills are prompt text
    // and stay automatic.
    discovery(
      [
        { name: "github", transport: "stdio" },
        { name: "linear", transport: "http" },
      ],
      [{ name: "pdf", description: "Fill PDF forms" }],
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // Badge shows the DISCOVERED (available) skills count — no per-skill toggle.
    await waitFor(() => expect(screen.getByTestId("skills-count")).toHaveTextContent("1"));

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).toMatchObject({ skills: "all" });
    expect(cap.last()).not.toHaveProperty("connectors");
    expect(cap.last()).not.toHaveProperty("disallowed_tools");
  });

  it("sends exactly the connectors that were toggled ON", async () => {
    discovery(
      [
        { name: "github", transport: "stdio" },
        { name: "linear", transport: "http" },
      ],
      [],
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.click(screen.getByTestId("skills-toggle"));
    fireEvent.click(await screen.findByRole("button", { name: "Connectors" }));
    fireEvent.click(await screen.findByTestId("cap-toggle-linear"));

    // Visible without opening the panel, because it is a per-turn cost.
    await waitFor(() => expect(screen.getByTestId("connectors-count")).toHaveTextContent("1 mcp"));

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()?.connectors).toEqual(["linear"]);
  });

  it("does not send connectors to a model that cannot use tools", async () => {
    // Enabling one and then picking DeepSeek must not produce a run the harness refuses.
    discovery([{ name: "github", transport: "stdio" }], []);
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json({
          providers: [
            {
              ...providersResponse([], { id: "bedrock-converse", displayName: "Bedrock" })
                .providers[0],
              models: [
                {
                  id: "us.deepseek.r1-v1:0",
                  displayName: "DeepSeek R1",
                  capabilities: { ...MODEL_CAPS, toolUse: false, toolUseWhileStreaming: false },
                },
              ],
            },
          ],
        }),
      ),
    );
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.click(screen.getByTestId("skills-toggle"));
    fireEvent.click(await screen.findByRole("button", { name: "Connectors" }));
    fireEvent.click(await screen.findByTestId("cap-toggle-github"));
    fireEvent.click(screen.getByTestId("skills-toggle"));

    await waitFor(() => {
      if (!screen.getByTestId("model").querySelector('option[value="us.deepseek.r1-v1:0"]')) {
        throw new Error("not yet");
      }
    });
    fireEvent.change(screen.getByTestId("model"), { target: { value: "us.deepseek.r1-v1:0" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).not.toHaveProperty("connectors");
    expect(cap.last()?.disallowed_tools).toEqual([...BUILTIN_TOOL_IDS]);
  });

  it("omits the capability fields on run start when the host has none", async () => {
    discovery([], []);
    const cap = captureRunStart();
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(cap.last()).not.toBeNull());
    expect(cap.last()).not.toHaveProperty("disallowed_tools");
    expect(cap.last()).not.toHaveProperty("connectors");
    expect(cap.last()).not.toHaveProperty("skills");
  });
});

describe("PromptComposer context bar", () => {
  beforeEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });
  afterEach(() => {
    useParticipantStore.getState().clear();
    useEventStore.getState().reset();
  });

  function runWithUsage(model: string, usage: Record<string, number>) {
    const started: EventEnvelope = {
      id: 1,
      session_id: "s",
      ai_run_id: "run1",
      seq: 2,
      type: "run_started",
      actor: { kind: "user", id: "1" },
      ts: "2026-07-20T00:00:00.000Z",
      payload: { model, cwd: "/r" },
    };
    const finished: EventEnvelope = {
      ...started,
      id: 2,
      seq: 9,
      type: "run_finished",
      actor: { kind: "claude" },
      payload: { usage },
    };
    useEventStore.getState().applyMany([started, finished]);
  }

  it("reads 0K / 200K · 0% before any run completes", () => {
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);
    expect(screen.getByTestId("context-usage")).toHaveTextContent("0K / 200K · 0%");
    expect(screen.getByTestId("context-bar-fill")).toHaveStyle({ width: "0%" });
  });

  it("uses the model's REAL context window as the denominator (opus-4.8 is 1M, not 200K)", async () => {
    // Regression: the window was hardcoded to 200K for every model, so a 1M model
    // (opus-4.8, sonnet-5, …) showed the wrong denominator + percentage. The real
    // window must come from model discovery (context_window / max_input_tokens).
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json(
          providersResponse([{ id: "claude-opus-4-8", label: "Opus 4.8", window: 1_000_000 }]),
        ),
      ),
    );
    // 120000 input + 4000 cache-read = 124000 → 124K of a 1M window → 12%.
    runWithUsage("claude-opus-4-8", {
      input_tokens: 120_000,
      output_tokens: 5000,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 0,
    });
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    // Window comes from model discovery (async), so wait for it to resolve to 1M.
    await waitFor(() =>
      expect(screen.getByTestId("context-usage")).toHaveTextContent("124K / 1M · 12%"),
    );
    expect(screen.getByTestId("context-bar-fill")).toHaveStyle({ width: "12%" });
    // The actual model that ran is surfaced (confirms the selection took effect).
    expect(screen.getByTestId("context-model")).toHaveTextContent("Opus 4.8");
  });

  it("reflects usage against a 200K-model window (haiku)", async () => {
    server.use(
      http.get("/api/models", () =>
        HttpResponse.json(
          providersResponse([{ id: "claude-haiku-4-5-20251001", label: "Haiku", window: 200_000 }]),
        ),
      ),
    );
    runWithUsage("claude-haiku-4-5-20251001", {
      input_tokens: 120_000,
      cache_read_input_tokens: 4000,
    });
    setRole("owner");
    renderComposer(<PromptComposer sessionId="s" />);

    expect(await screen.findByTestId("context-usage")).toHaveTextContent("124K / 200K · 62%");
  });
});
