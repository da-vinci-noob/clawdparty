import type { ProviderStatus } from "@clawdparty/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../../test/msw_server";
import { renderWithQuery } from "../../../test/render_with_query";
import { AuthTestTab } from "./auth_test_tab";

/**
 * The tab keeps two different claims apart.
 *
 * `GET /api/models` says a credential and a region were FOUND. It does not say a request would be
 * accepted, and on this host that gap is real: `nova-premier` is refused on entitlement with a valid
 * credential, and a correctly-configured MCP server answered `invalid_token`. A tab that shows one
 * green tick for both would be the thing it exists to prevent.
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

function providers(entries: ProviderStatus[]) {
  server.use(http.get("/api/models", () => HttpResponse.json({ providers: entries })));
}

const available = (id: string, label: string): ProviderStatus => ({
  id,
  displayName: label,
  available: true,
  credentialSource: "env:AWS_PROFILE",
  models: [{ id: `${id}-model`, displayName: "A model", capabilities: CAPS }],
});

const unavailable = (id: string, label: string): ProviderStatus => ({
  id,
  displayName: label,
  available: false,
  reason: "no_credential",
  remedy: "Run claude setup-token",
  models: [],
});

function verdicts(body: Record<string, unknown>) {
  server.use(http.post("/api/providers/verify", () => HttpResponse.json(body)));
}

afterEach(() => server.resetHandlers());

describe("before any test is run", () => {
  it("shows discovery only, and says that is all it means", async () => {
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    renderWithQuery(<AuthTestTab />);

    const row = await screen.findByTestId("auth-provider-anthropic-bedrock");
    expect(row).toHaveTextContent(/discovered/i);
    // The sentence that keeps the two claims apart.
    expect(row).toHaveTextContent(/only means a credential was found/i);
    expect(screen.queryByTestId("auth-verdict-anthropic-bedrock")).not.toBeInTheDocument();
  });

  it("lists an unavailable provider too, rather than omitting it", async () => {
    // omitting it is what produces "the picker is just empty" with no way to learn why.
    providers([unavailable("anthropic-direct", "Anthropic (direct)")]);
    renderWithQuery(<AuthTestTab />);

    expect(await screen.findByTestId("auth-discovered-anthropic-direct")).toHaveTextContent(
      /unavailable/i,
    );
  });

  it("states the cost of running it", async () => {
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    renderWithQuery(<AuthTestTab />);

    // A check whose cost is hidden is one people stop trusting.
    expect(await screen.findByText(/1-token request per provider/i)).toBeInTheDocument();
  });
});

describe("after running the test", () => {
  it("marks a provider VERIFIED with the model it proved it with", async () => {
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    verdicts({
      providers: [
        {
          id: "anthropic-bedrock",
          displayName: "Amazon Bedrock",
          ok: true,
          model: "us.anthropic.claude-opus-4-1-20250805-v1:0",
          credentialSource: "env:AWS_PROFILE",
          usage: { input_tokens: 0, output_tokens: 1 },
          durationMs: 7570,
        },
      ],
    });
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    const verdict = await screen.findByTestId("auth-verdict-anthropic-bedrock");
    expect(verdict).toHaveTextContent(/verified/i);
    const row = screen.getByTestId("auth-provider-anthropic-bedrock");
    expect(row).toHaveTextContent(/claude-opus-4-1/);
    expect(row).toHaveTextContent(/7570ms/);
    expect(row).toHaveTextContent(/0 in \/ 1 out/);
  });

  it("shows the provider's OWN refusal message, which is the diagnostic", async () => {
    // "AccessDeniedException", "expired", "invalid_token" — paraphrasing throws away the only
    // actionable part, and this is the exact case probe() reports as fine.
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    verdicts({
      providers: [
        {
          id: "anthropic-bedrock",
          displayName: "Amazon Bedrock",
          ok: false,
          model: "us.amazon.nova-premier-v1:0",
          error: "AccessDeniedException: You don't have access to the model",
        },
      ],
    });
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    expect(await screen.findByTestId("auth-verdict-anthropic-bedrock")).toHaveTextContent(
      /failed/i,
    );
    expect(screen.getByTestId("auth-error-anthropic-bedrock")).toHaveTextContent(
      /AccessDeniedException/,
    );
  });

  it("shows the remedy AND the raw error when a good credential's request fails", async () => {
    // Screenshotted from the running app: the host-login card showed
    // `429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":…}`
    // and nothing else. The harness had started classifying that (reason `api_error`, remedy "Wait
    // and retry") but the render guard was `verdict.reason && !verdict.error` — so the raw JSON
    // SUPPRESSED the actionable words. The vendor's own `message` there is the word "Error".
    providers([available("anthropic-oauth", "Anthropic (host login)")]);
    verdicts({
      providers: [
        {
          id: "anthropic-oauth",
          displayName: "Anthropic (host login)",
          ok: false,
          model: "claude-opus-5",
          credentialSource: "keychain:anthropic-oauth",
          reason: "api_error",
          remedy: "Wait and retry; reduce concurrent runs if this persists.",
          error:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_011Ce8"}',
        },
      ],
    });
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    // The actionable sentence must be present, not replaced by the payload.
    expect(await screen.findByTestId("auth-reason-anthropic-oauth")).toHaveTextContent(
      /wait and retry/i,
    );
    // And the raw text stays, because the `request_id` is the one thing a vendor support thread
    // needs and no classifier can reconstruct it.
    expect(screen.getByTestId("auth-error-anthropic-oauth")).toHaveTextContent(/req_011Ce8/);
  });

  it("shows the reason and remedy when it was never attempted", async () => {
    providers([unavailable("anthropic-direct", "Anthropic (direct)")]);
    verdicts({
      providers: [
        {
          id: "anthropic-direct",
          displayName: "Anthropic (direct)",
          ok: false,
          reason: "no_credential",
          remedy: "Run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN",
        },
      ],
    });
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    expect(await screen.findByTestId("auth-reason-anthropic-direct")).toHaveTextContent(
      /claude setup-token/,
    );
  });

  it("names the credential SOURCE and never a value", async () => {
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    verdicts({
      providers: [
        {
          id: "anthropic-bedrock",
          displayName: "Amazon Bedrock",
          ok: true,
          model: "m",
          credentialSource: "profile:active",
        },
      ],
    });
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    expect(await screen.findByTestId("auth-source-anthropic-bedrock")).toHaveTextContent(
      "profile:active",
    );
  });

  it("surfaces a transport failure instead of looking like a pass", async () => {
    providers([available("anthropic-bedrock", "Amazon Bedrock")]);
    server.use(
      http.post("/api/providers/verify", () =>
        HttpResponse.json(
          { errors: [{ message: "The harness is unavailable; try again" }] },
          { status: 502 },
        ),
      ),
    );
    renderWithQuery(<AuthTestTab />);
    fireEvent.click(await screen.findByTestId("auth-test-run"));

    expect(await screen.findByTestId("auth-test-error")).toHaveTextContent(
      /harness is unavailable/i,
    );
    expect(screen.queryByTestId("auth-verdict-anthropic-bedrock")).not.toBeInTheDocument();
  });
});

describe("no providers at all", () => {
  it("says the harness may be down rather than rendering an empty page", async () => {
    providers([]);
    renderWithQuery(<AuthTestTab />);

    await waitFor(() => expect(screen.getByTestId("auth-no-providers")).toBeInTheDocument());
  });
});
