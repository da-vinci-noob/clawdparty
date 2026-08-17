import type { EventEnvelope, ProviderErrorPayload } from "@clawdparty/contracts";
import type { FC } from "react";

/**
 * A provider/credential failure, named.
 *
 * requires the message to name the specific credential AND the action that fixes it —
 * a payload dump satisfies neither, and `RawFallback` is what these landed in until now.
 *
 * Deliberately NOT styled as a run failure. The credential is broken, the session is not: a
 * refreshed credential makes the next run work, so a row that reads as fatal would send the
 * room off to create a new session for nothing.
 */

const KIND_LABEL: Record<ProviderErrorPayload["kind"], string> = {
  no_credential: "no credential found",
  credential_expired: "credential expired",
  not_entitled: "not entitled",
  region_unset: "region not set",
  unreachable: "provider unreachable",
  api_error: "provider error",
};

export const ProviderErrorRow: FC<{ event: EventEnvelope }> = ({ event }) => {
  const payload = event.payload as Partial<ProviderErrorPayload>;
  // An unknown kind still renders — a harness newer than the web must not blank the row.
  const label = (payload.kind && KIND_LABEL[payload.kind]) || payload.kind || "provider error";

  return (
    <div
      data-testid="feed-provider-error"
      className="flex items-start gap-2 rounded-[8px] border border-[#3a2a17] bg-[#1a1206] px-3 py-2 text-[12px]"
    >
      <span className="mt-[2px] shrink-0 text-[#e0a04a]" aria-hidden="true">
        ⚠
      </span>
      <div className="min-w-0">
        <div className="text-[#e0a04a]">
          {label}
          {payload.provider && (
            <span data-testid="feed-provider-error-provider" className="text-[#8a7a5a]">
              {" "}
              · {payload.provider}
            </span>
          )}
        </div>
        {payload.message && (
          <div data-testid="feed-provider-error-message" className="break-words text-[#a8987a]">
            {payload.message}
          </div>
        )}
        {payload.remedy && (
          <div
            data-testid="feed-provider-error-remedy"
            className="mt-1 break-words font-semibold text-[#cdb98a]"
          >
            Fix: {payload.remedy}
          </div>
        )}
        <div data-testid="feed-provider-error-survivable" className="mt-1 text-[#7a7060]">
          The session stays usable — start a new run once this is fixed.
        </div>
      </div>
    </div>
  );
};
