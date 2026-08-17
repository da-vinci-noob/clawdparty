import type { FC } from "react";
import { useModels, useUnavailableProviders } from "../../hooks/use_models";
import {
  type ProviderVerdict,
  useProviderVerification,
} from "../../hooks/use_provider_verification";

// Settings → Auth test. Two DIFFERENT claims, kept visibly apart:
//
//   discovered  a credential and a region were found, and these models were listed (GET /api/models)
//   verified    a real request was sent and accepted (POST /api/providers/verify)
//
// Collapsing them would be the lie this tab exists to prevent: on this host `nova-premier` has a
// valid credential and is refused on entitlement, and a correctly-configured MCP server answered
// `invalid_token`. "A credential exists" and "a run will work" are not the same sentence.

const SCOPE_NOTE =
  "Providers are host-wide: this reflects the machine running clawdparty, not just this session.";

export const AuthTestTab: FC = () => {
  const models = useModels();
  const unavailable = useUnavailableProviders();
  const { verdicts, run, running, error } = useProviderVerification();

  // Discovered providers, from the model list (available ones) plus the reported-unavailable ones.
  const discovered = [...new Map(models.map((m) => [m.provider, m.providerLabel])).entries()].map(
    ([id, label]) => ({ id, label, available: true }),
  );
  const rows = [
    ...discovered,
    ...unavailable.map((p) => ({ id: p.id, label: p.label, available: false })),
  ];
  const verdictFor = (id: string): ProviderVerdict | undefined =>
    verdicts?.find((v) => v.id === id);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-[#6b726b]">{SCOPE_NOTE}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="auth-test-run"
          onClick={run}
          disabled={running}
          className="rounded-[9px] bg-[#3b9dff] px-[13px] py-[7px] font-mono text-[12px] font-semibold text-[#04101f] disabled:opacity-50"
        >
          {running ? "Testing…" : "Test all providers"}
        </button>
        <span className="text-[11px] text-[#565d58]">
          {/* Stated, because a check whose cost is hidden is one people stop trusting. */}
          Sends one 1-token request per provider.
        </span>
      </div>

      {error && (
        <p data-testid="auth-test-error" className="text-[12px] text-[#f0a8a8]">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((row) => {
          const verdict = verdictFor(row.id);
          return (
            <li
              key={row.id}
              data-testid={`auth-provider-${row.id}`}
              className="rounded-[10px] border border-[#17231b] bg-[#0c0e0c] px-3 py-[10px]"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-[13px] text-[#e6e8e6]">{row.label}</span>
                <span
                  data-testid={`auth-discovered-${row.id}`}
                  className={`rounded-[6px] px-[7px] py-[2px] font-mono text-[10px] uppercase ${
                    row.available ? "bg-[#0f1c2b] text-[#3b9dff]" : "bg-[#241a1a] text-[#f0a8a8]"
                  }`}
                >
                  {row.available ? "discovered" : "unavailable"}
                </span>
                {verdict && (
                  <span
                    data-testid={`auth-verdict-${row.id}`}
                    className={`rounded-[6px] px-[7px] py-[2px] font-mono text-[10px] uppercase ${
                      verdict.ok ? "bg-[#10240f] text-[#7cd992]" : "bg-[#241a1a] text-[#f0a8a8]"
                    }`}
                  >
                    {verdict.ok ? "verified" : "failed"}
                  </span>
                )}
              </div>

              <dl className="mt-[6px] space-y-[3px] text-[11px] text-[#7c847c]">
                {verdict?.credentialSource && (
                  <div data-testid={`auth-source-${row.id}`}>
                    {/* A NAME, never a value . */}
                    credential: <span className="text-[#aeb4ae]">{verdict.credentialSource}</span>
                  </div>
                )}
                {verdict?.model && (
                  <div>
                    tested with: <span className="text-[#aeb4ae]">{verdict.model}</span>
                    {verdict.durationMs !== undefined && ` · ${Math.round(verdict.durationMs)}ms`}
                    {verdict.usage &&
                      ` · ${verdict.usage.input_tokens ?? 0} in / ${verdict.usage.output_tokens ?? 0} out`}
                  </div>
                )}
                {/* The CLASSIFICATION first, whether or not there is raw text beside it. This used
                    to be `reason && !error`, so a raw payload suppressed the actionable words — and a
                    real 429 rendered as `{"error":{"type":"rate_limit_error","message":"Error"}}`
                    with no statement of what to do, the vendor's own message being "Error". */}
                {verdict?.reason && (
                  <div data-testid={`auth-reason-${row.id}`} className="text-[#c9a227]">
                    {verdict.reason}
                    {verdict.remedy ? ` — ${verdict.remedy}` : ""}
                  </div>
                )}
                {/* The provider's own words, KEPT but secondary: "AccessDeniedException", "expired",
                    "invalid_token" and the `request_id` are the diagnostic a support thread needs,
                    and no classifier can reconstruct them. Dimmer, because it is detail rather than
                    instruction — and it is the only line when nothing classified the failure. */}
                {verdict?.error && (
                  <div
                    data-testid={`auth-error-${row.id}`}
                    className={verdict.reason ? "text-[#8a6f6f]" : "text-[#f0a8a8]"}
                  >
                    {verdict.error}
                  </div>
                )}
                {!verdict && (
                  <div className="text-[#565d58]">
                    not tested yet — “discovered” only means a credential was found.
                  </div>
                )}
              </dl>
            </li>
          );
        })}
      </ul>

      {rows.length === 0 && (
        <p data-testid="auth-no-providers" className="text-[12px] text-[#6b726b]">
          No providers reported. The harness may be down.
        </p>
      )}
    </div>
  );
};
