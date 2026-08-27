import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FC, useState } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";

/**
 * The extensions panel.
 *
 * Active contributors and what they contribute are visible to **every** participant, because a
 * `tool:before` gate decides what Claude may do — a viewer watching a refusal should be able to see
 * which rule refused it. Toggling is owner-only, and the client only hides the control; the server's
 * `SessionPolicy` is what enforces it.
 *
 * BUNDLED ONLY, and the panel says so rather than leaving a reader to wonder where the install
 * button is. A measurement showed that a `worker_thread` with `env: {}` isolates the environment
 * and nothing else, so third-party loading is deliberately not built. Stating that here is the
 * honest version of 's trust framing: there is no trust decision to present, because there
 * is no foreign code to trust.
 */

interface PluginRow {
  id: string;
  version: string;
  origin: "bundled" | "external";
  contributes: string[];
  summary: string;
  /** `null` when the server was asked without a session — should not happen from this panel. */
  enabled: boolean | null;
}

async function fetchPlugins(sessionId: string): Promise<PluginRow[]> {
  const res = await fetch(`/api/sessions/${sessionId}/plugins`, { credentials: "include" });
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as { plugins?: PluginRow[] };
  return body.plugins ?? [];
}

export const ExtensionsTab: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const canManage = can("manage_session");

  const { data: plugins = [] } = useQuery({
    queryKey: ["plugins", sessionId],
    queryFn: () => fetchPlugins(sessionId),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/sessions/${sessionId}/plugins/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          errors?: { message: string }[];
        } | null;
        throw new Error(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
      }
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["plugins", sessionId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div data-testid="extensions-tab" className="space-y-3">
      <p className="text-[12px] text-[#7c847c]">
        Rules that can refuse what Claude does. Everyone can see which are in force;
        {canManage ? " you can change them." : " only the owner can change them."}
      </p>
      {/* WHEN it applies, stated up front. A toggle resolves at run start, so a change made
          during a run does not alter that run — and someone who expected it to would otherwise read
          the unchanged behaviour as the toggle not working. To stop something happening now, the
          control is interrupt. */}
      <p data-testid="extensions-timing" className="text-[11px] text-[#6b726b]">
        A change applies to the <strong className="font-semibold">next run</strong>. To stop a run
        that is already going, interrupt it.
      </p>

      <ul className="space-y-2">
        {plugins.map((plugin) => (
          <li
            key={plugin.id}
            data-testid={`extension-${plugin.id}`}
            className="rounded-[8px] border border-[#17231b] bg-[#0e140f] px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-[7px]">
                  <span
                    data-testid={`extension-state-${plugin.id}`}
                    className={plugin.enabled ? "text-[#7cd992]" : "text-[#6b726b]"}
                    aria-hidden="true"
                  >
                    {plugin.enabled ? "●" : "○"}
                  </span>
                  <span className="font-mono text-[12px] text-[#cdd2cd]">{plugin.id}</span>
                  <span className="font-mono text-[10px] text-[#565d58]">v{plugin.version}</span>
                  <span className="rounded-[5px] bg-[#0a1826] px-[6px] py-px font-mono text-[10px] text-[#3b9dff]">
                    {plugin.origin}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[#7c847c]">{plugin.summary}</p>
                {/* What it can DO, from the descriptor — so a reader knows the scope of the rule
                    rather than only its name . */}
                <p
                  data-testid={`extension-contributes-${plugin.id}`}
                  className="mt-[2px] font-mono text-[10px] text-[#565d58]"
                >
                  {plugin.contributes.join(", ")}
                </p>
              </div>

              {canManage ? (
                <button
                  type="button"
                  data-testid={`extension-toggle-${plugin.id}`}
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: plugin.id, enabled: !plugin.enabled })}
                  className="shrink-0 rounded-[7px] border border-[#17231b] bg-[#0c110d] px-[10px] py-[5px] font-mono text-[11px] text-[#cdd2cd] transition hover:border-[#2c5580] disabled:opacity-50"
                >
                  {plugin.enabled ? "Disable" : "Enable"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {!canManage && (
        <p data-testid="extensions-read-only" className="text-[11px] text-[#6b726b]">
          Only the session owner can enable or disable a rule.
        </p>
      )}

      {error && (
        <p data-testid="extensions-error" className="text-[12px] text-[#f0a8a8]">
          {error}
        </p>
      )}

      {/* Stated, not implied. Someone looking for "install a plugin" deserves to know it is a
          decision rather than a missing button. */}
      <p data-testid="extensions-bundled-only" className="text-[11px] text-[#6b726b]">
        Only bundled rules can run. Third-party extensions are not supported: a worker thread cannot
        contain code that reads your credentials, so loading it would be a trust decision dressed up
        as a boundary.
      </p>
    </div>
  );
};
