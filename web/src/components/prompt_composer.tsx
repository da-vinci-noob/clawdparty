import { type FC, type FormEvent, useState } from "react";
import { useConnectors } from "../hooks/use_connectors";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { useModels } from "../hooks/use_models";
import { useSkills } from "../hooks/use_skills";
import {
  selectActiveRunId,
  selectAwaitingReviewRunId,
  selectLatestUsage,
  useEventStore,
} from "../stores/event_store";
import { SkillsPopover } from "./session/skills_popover";

// Denominator when no discovered model matches (empty "Default" selection with no
// completed run). Real windows come from model discovery (context_window).
const DEFAULT_CONTEXT_WINDOW = 200_000;
const tokensToK = (n: number): string =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;

// Prompt composer: starts a run when none is active, sends a follow-up when one is,
// and submits a `revise` follow-up while awaiting review. When starting a run the
// user picks a model, tools, connectors and skills.
//
// The permission-mode selector and the "Execute plan" shortcut are GONE with the
// parameter itself (CHANGELOG B2): permission modes were an Agent SDK concept, and
// policy now lives at the `tool:before` extension point plus the per-run tool set.
// Rendered only for owner/editor (client gating is presentation only — the server
// SessionPolicy gates).
export const PromptComposer: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const models = useModels();
  // Capabilities have no per-item toggle: every host connector + installed skill is
  // available to the run (all tools stay on). The composer sends that enablement on
  // run start; these are the real discovered lists (for the badge + what to send).
  const connectors = useConnectors(sessionId);
  const skills = useSkills(sessionId);
  const activeRunId = useEventStore(selectActiveRunId);
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);
  // Select PRIMITIVES (not the object) so a new reference each render can't loop Zustand.
  const contextTokens = useEventStore((s) => selectLatestUsage(s)?.contextTokens ?? 0);
  const usageModel = useEventStore((s) => selectLatestUsage(s)?.model ?? null);
  const [text, setText] = useState("");
  // Empty = let the server resolve a default from what the chosen provider actually serves.
  // Set once the user chooses; the option list itself comes from runtime discovery.
  const [model, setModel] = useState("");
  const [skillOpen, setSkillOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("run")) {
    return null;
  }

  const revising = !activeRunId && reviewRunId !== null;

  // Derived, never a second dropdown: the participant picks a MODEL, and the provider is
  // whichever one listed it. Two independent selectors would let them disagree.
  const selectedProvider = models.find((m) => m.id === model)?.provider ?? "";

  // One group per provider, in discovery order. `Map` rather than an object so the order the
  // harness reported is preserved — it is the host's preference order, not alphabetical.
  const providerGroups = [
    ...models
      .reduce((groups, m) => {
        groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
        return groups;
      }, new Map<string, typeof models>())
      .entries(),
  ];

  const startRun = (prompt: string): Promise<Response> =>
    fetch(`/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        prompt,
        ...(model ? { model } : {}),
        // The PROVIDER that serves the chosen model, sent alongside it.
        //
        // Load-bearing, and its absence was a live defect: the picker offers models from
        // every available provider, so a Bedrock inference-profile id could be selected while
        // the server fell back to `anthropic-direct` — which rejects it outright. A model id
        // only means something relative to the provider that listed it.
        ...(selectedProvider ? { provider: selectedProvider } : {}),
        ...(revising ? { mode: "revise" } : {}),
        // No per-item toggles: every discovered connector + skill is enabled (all
        // tools stay on, so no disallowed_tools). Omitted when the host has none →
        // today's behavior.
        ...(connectors.length ? { connectors: connectors.map((c) => c.name) } : {}),
        ...(skills.length ? { skills: "all" as const } : {}),
      }),
    });

  const surfaceError = async (res: Response): Promise<boolean> => {
    if (res.ok) {
      return true;
    }
    const body = (await res.json().catch(() => null)) as { errors?: { message: string }[] } | null;
    setError(body?.errors?.[0]?.message ?? `Request failed (${res.status})`);
    return false;
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!text.trim()) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = activeRunId
        ? await fetch(`/api/runs/${activeRunId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ message: text }),
          })
        : await startRun(text);
      if (await surfaceError(res)) {
        setText("");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const showModeControl = !activeRunId; // a new run is created (start or revise)

  // Real context usage from the latest completed run (0 until the first run finishes).
  // Window follows that run's model (falling back to the currently-selected model),
  // read from the discovered models list — falling back to 200K when nothing matches.
  const windowModelId = usageModel ?? model;
  const contextWindow =
    models.find((m) => m.id === windowModelId)?.context_window ?? DEFAULT_CONTEXT_WINDOW;
  const contextPct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
  // The model the latest run ACTUALLY used (from run_started), so a viewer can
  // confirm the selection took effect — Claude can't reliably introspect this itself.
  const runModelLabel = usageModel
    ? (models.find((m) => m.id === usageModel)?.label ?? usageModel)
    : null;

  return (
    <div className="relative z-[2] px-[18px] pb-4">
      {skillOpen && showModeControl && (
        <SkillsPopover sessionId={sessionId} onClose={() => setSkillOpen(false)} />
      )}

      <form
        onSubmit={submit}
        data-testid="prompt-composer"
        className="overflow-hidden rounded-[15px] border border-[#17231b] bg-[#0c0e0c] shadow-[0_8px_30px_rgba(0,0,0,.35)]"
      >
        {/* Live context-usage bar: the latest completed run's prompt-side tokens
            (from run_finished/run_failed `usage`) over the model's window. Reads 0
            until the first run finishes; updates at run end, not live mid-stream. */}
        <div className="flex items-center gap-[10px] px-[15px] pt-[10px]">
          <span className="font-mono text-[10px] tracking-[0.5px] text-[#6b726b]">CONTEXT</span>
          <div className="h-1 flex-1 overflow-hidden rounded-[3px] bg-[#1c2a20]">
            <div
              data-testid="context-bar-fill"
              className="h-full rounded-[3px] bg-[#3b9dff] transition-[width] duration-500"
              style={{ width: `${contextPct}%`, boxShadow: "0 0 10px rgba(59,157,255,.55)" }}
            />
          </div>
          <span data-testid="context-usage" className="font-mono text-[10px] text-[#7c847c]">
            {runModelLabel && (
              <span data-testid="context-model" className="text-[#565d58]">
                {runModelLabel} ·{" "}
              </span>
            )}
            {tokensToK(contextTokens)} / {tokensToK(contextWindow)} · {contextPct}%
          </span>
        </div>

        {/* prompt input row */}
        <div className="flex items-center gap-[10px] px-[15px] py-[10px] font-mono text-[14px]">
          <span
            className="text-[#3b9dff]"
            style={{
              animation: "cp-blink 1.1s step-end infinite",
              textShadow: "0 0 10px rgba(59,157,255,.5)",
            }}
          >
            ❯
          </span>
          <input
            aria-label="Prompt"
            placeholder={
              activeRunId
                ? "Send a follow-up…"
                : revising
                  ? "Revise the changes…"
                  : "Message the room + clawd…"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="flex-1 bg-transparent text-[#e6e8e6] placeholder:text-[#5c6b5f] focus:outline-none"
          />
        </div>

        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-[13px] pb-3">
          {/* Model dropdown — options come from runtime discovery (useModels); the chosen id
              is sent as `model` plus the `provider` that listed it (empty = server resolves
              from what the provider serves). GROUPED by provider, because ids alone do not
              say which account a run will spend: "Claude Opus 5" under Anthropic (direct)
              and under Amazon Bedrock bill different places . */}
          {showModeControl && (
            <select
              aria-label="Model"
              data-testid="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] hover:border-[#2c5580] focus:outline-none"
            >
              <option value="">Default model</option>
              {providerGroups.map(([providerId, group]) => (
                <optgroup key={providerId} label={group[0]?.providerLabel ?? providerId}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}

          {/* Tools/Connectors/Skills popover trigger. The badge shows how many
              skills the host has available (all are usable by the run — skills have
              no per-skill toggle). Only shown when a new run is being configured; the
              whole composer is already hidden from reviewer/viewer (no `run` cap). */}
          {showModeControl && (
            <button
              type="button"
              data-testid="skills-toggle"
              onClick={() => setSkillOpen((v) => !v)}
              className={`flex items-center gap-[7px] rounded-[9px] border px-[11px] py-[7px] font-mono text-[12px] ${
                skillOpen
                  ? "border-[#2c5580] bg-[#0a1826] text-[#3b9dff]"
                  : "border-[#17231b] bg-[#0e140f] text-[#cdd2cd] hover:border-[#2c5580]"
              }`}
            >
              <span className="text-[12px]">✦</span> Skills
              <span
                data-testid="skills-count"
                className="rounded-full bg-[#0a1826] px-[6px] py-px text-[10px] font-semibold text-[#3b9dff]"
              >
                {skills.length}
              </span>
            </button>
          )}

          <div className="flex-1" />

          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-[7px] rounded-[10px] bg-[#3b9dff] px-[15px] py-[8px] font-mono text-[12px] font-semibold text-[#04101f] shadow-[0_0_16px_rgba(59,157,255,.35)] transition hover:brightness-110 disabled:opacity-50"
          >
            <span>{activeRunId ? "Send" : revising ? "Revise" : "Run"}</span>
            <span className="opacity-55" aria-hidden="true">
              ⌘↵
            </span>
          </button>
        </div>

        {error && (
          <p
            data-testid="composer-error"
            className="px-[15px] pb-3 font-mono text-[12px] text-[#f0a8a8]"
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
};
