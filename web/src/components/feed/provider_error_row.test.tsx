import type { EventEnvelope, ProviderErrorPayload } from "@clawdparty/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderErrorRow } from "./provider_error_row";

/**
 * 's two requirements are the two assertions that matter: the row NAMES the
 * credential and it STATES THE FIX. Everything else is presentation.
 *
 * The payload shape is imported from `packages/contracts`, not hand-written, so a rename on the
 * harness side is a compile error here rather than a row that silently renders nothing (a
 * recurring class: four contract changes shipped one side at a time with both suites green).
 */

const event = (payload: Partial<ProviderErrorPayload>): EventEnvelope =>
  ({
    id: 1,
    session_id: "s",
    ai_run_id: "r",
    seq: 1,
    type: "provider_error",
    actor: { kind: "system" },
    ts: "2026-01-01T00:00:00Z",
    payload,
  }) as unknown as EventEnvelope;

describe("what  requires", () => {
  const full = event({
    provider: "anthropic-bedrock",
    kind: "credential_expired",
    message: "AWS SSO session for profile claude-code-sso has expired",
    remedy: "Run `aws sso login --profile claude-code-sso`",
  });

  it("names the provider whose credential failed", () => {
    render(<ProviderErrorRow event={full} />);
    expect(screen.getByTestId("feed-provider-error-provider")).toHaveTextContent(
      "anthropic-bedrock",
    );
  });

  it("states the action that fixes it", () => {
    render(<ProviderErrorRow event={full} />);
    expect(screen.getByTestId("feed-provider-error-remedy")).toHaveTextContent(
      "aws sso login --profile claude-code-sso",
    );
  });

  it("reads the kind as words rather than an enum token", () => {
    render(<ProviderErrorRow event={full} />);
    expect(screen.getByTestId("feed-provider-error")).toHaveTextContent(/credential expired/);
  });

  it("says the session is still usable", () => {
    // The row must not read as a run failure: the credential is broken, the session is not.
    render(<ProviderErrorRow event={full} />);
    expect(screen.getByTestId("feed-provider-error-survivable")).toHaveTextContent(/stays usable/i);
  });
});

describe("a payload from a newer harness", () => {
  it("renders an unknown kind verbatim instead of blanking the row", () => {
    render(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately a kind this build has never seen
      <ProviderErrorRow event={event({ kind: "quota_exhausted" as any, provider: "p" })} />,
    );
    expect(screen.getByTestId("feed-provider-error")).toHaveTextContent("quota_exhausted");
  });

  it("renders with no message or remedy at all", () => {
    render(<ProviderErrorRow event={event({ kind: "unreachable" })} />);

    expect(screen.getByTestId("feed-provider-error")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-provider-error-remedy")).not.toBeInTheDocument();
  });
});
