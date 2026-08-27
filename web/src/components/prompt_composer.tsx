import { BUILTIN_TOOL_IDS } from "@clawdparty/contracts";
import { type FC, type FormEvent, useState } from "react";
import { useConnectors } from "../hooks/use_connectors";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { useModels, useUnavailableProviders } from "../hooks/use_models";
import { useSkills } from "../hooks/use_skills";
import {
  selectActiveRunId,
  selectAwaitingReviewRunId,
  selectLatestUsage,
  selectLiveContext,
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
  // Providers that CANNOT serve, with the reason and the fix. Shown rather than dropped: a
  // picker missing Bedrock and a host with no Bedrock credential look identical otherwise, and
  // has the harness report every provider precisely so the absence can be explained.
  const unavailable = useUnavailableProviders();
  // Tools and skills have no per-item toggle — every built-in tool and every installed skill is
  // available. CONNECTORS do, and default to off: enabling one connects to that MCP server and
  // declares every tool it advertises. These are the discovered lists (the badge + validation of
  // what can be sent).
  const connectors = useConnectors(sessionId);
  const skills = useSkills(sessionId);
  const activeRunId = useEventStore(selectActiveRunId);
  const markRunPending = useEventStore((s) => s.markRunPending);
  const clearRunPending = useEventStore((s) => s.clearRunPending);
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);
  // Select PRIMITIVES (not the object) so a new reference each render can't loop Zustand.
  const contextTokens = useEventStore((s) => selectLatestUsage(s)?.contextTokens ?? 0);
  const usageModel = useEventStore((s) => selectLatestUsage(s)?.model ?? null);
  // The LIVE reading, when a turn has reported one. Primitives again, for the same reason.
  const liveTokens = useEventStore((s) => selectLiveContext(s)?.contextTokens ?? null);
  const liveWindow = useEventStore((s) => selectLiveContext(s)?.window ?? null);
  const [text, setText] = useState("");
  // Empty = let the server resolve a default from what the chosen provider actually serves.
  // Set once the user chooses; the option list itself comes from runtime discovery.
  const [model, setModel] = useState("");
  const [skillOpen, setSkillOpen] = useState(false);
  // Connectors are OPT-IN per run and default to none. Enabling one makes the harness connect to
  // that MCP server and declare every tool it advertises, which on this host measured ~37,500
  // tokens of schema across all 8 servers — a cost worth choosing rather than inheriting.
  const [connectorNames, setConnectorNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("run")) {
    return null;
  }

  const revising = !activeRunId && reviewRunId !== null;

  // Derived, never a second dropdown: the participant picks a MODEL, and the provider is
  // whichever one listed it. Two independent selectors would let them disagree.
  const selected = models.find((m) => m.id === model);
  const selectedProvider = selected?.provider ?? "";
  // Only an EXPLICIT false. An absent field is version skew, and reading it as "no tools" would
  // strip every tool from a model that has them.
  const toolLess = selected?.toolUse === false;

  // Filtered against DISCOVERY, so a name that vanished from host config cannot be sent (Rails
  // validates the same thing, and a stale selection would 422 the whole run start).
  const enabledConnectors = connectorNames.filter((name) =>
    connectors.some((c) => c.name === name),
  );
  const toggleConnector = (name: string): void =>
    setConnectorNames((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );

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
        // A model that cannot use tools at all (DeepSeek R1) gets a run with every tool
        // DISALLOWED and no connectors — the harness refuses a run that offers it tools, because
        // a model that cannot act would otherwise narrate actions it never took. Skills are
        // prompt text, not tools, so they stay.
        ...(toolLess ? { disallowed_tools: BUILTIN_TOOL_IDS } : {}),
        // Only the connectors the participant ENABLED, and never on a model that cannot use tools
        // at all. Omitted when none are on, which is the default.
        ...(!toolLess && enabledConnectors.length ? { connectors: enabledConnectors } : {}),
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
        // The room shows "working" from HERE, not from `run_started`: between a successful POST
        // and the harness's first event nothing is derivable from the stream, and that silence
        // read as the app not processing at all.
        markRunPending();
      } else {
        // Refused (4xx). No event will ever arrive, so withdraw the flag explicitly or the
        // indicator spins forever on an error the participant can already see.
        clearRunPending();
      }
    } catch {
      setError("Network error");
      clearRunPending();
    } finally {
      setBusy(false);
    }
  };

  const showModeControl = !activeRunId; // a new run is created (start or revise)

  // Context usage, LIVE where the harness has reported it and per-run otherwise.
  //
  // The live figure is `context_usage`, emitted every turn , and it wins because it is
  // fresher: the per-run one only exists once a run has ENDED, so the bar used to sit at the
  // previous run's number for the whole of the next one. Its window comes from the event — the
  // adapter's real `capabilities().contextWindow` — so a mid-session model switch re-bases the
  // denominator here with no model lookup at all.
  //
  // The per-run fallback is not redundant: `context_usage` is ephemeral and never backfilled, so
  // a reload or a late joiner has none of it and reads the durable figure instead.
  // The model the NEXT turn will use: the explicit selection when there is one, and otherwise the
  // most recent run's model as the best available evidence of what the server will resolve.
  //
  // The SELECTION WINS, and it used to lose. This was `usageModel ?? model`, where `usageModel` is
  // the last TERMINAL run's model (`selectLatestUsage` scans `run_finished`/`run_failed`) — so a
  // finished run outranked the user's current pick indefinitely, until another run finished.
  // Reported from the running app: the gauge read `US OpenAI GPT-5.6 Sol · 4K / 131K · 3%` beside a
  // picker reading `Claude Opus 5`. The label going stale is the visible half; the DENOMINATOR going
  // stale is the harmful one, because the percentage was then measured against a window the next run
  // would not have — 3% of 131K where the truth was 0% of 1M.
  //
  // Token count is deliberately NOT re-based: a conversation's context carries across a model
  // switch. Only the window belongs to the model.
  const windowModelId = model || usageModel;
  const contextWindow =
    liveWindow ??
    models.find((m) => m.id === windowModelId)?.context_window ??
    DEFAULT_CONTEXT_WINDOW;
  const shownTokens = liveTokens ?? contextTokens;
  const contextPct = Math.min(100, Math.round((shownTokens / contextWindow) * 100));
  // Labels whichever model the DENOMINATOR belongs to, so the two can never disagree. It does not
  // try to answer "did my selection take effect?" any more — the previous comment claimed to read
  // `run_started` and did not, and answering that here is what made it contradict the picker. The
  // activity feed's `run_started` and `request_header` record the model a run actually used.
  const runModelLabel = windowModelId
    ? (models.find((m) => m.id === windowModelId)?.label ?? windowModelId)
    : null;

  return (
    <div className="relative z-[2] px-[18px] pb-4">
      {skillOpen && showModeControl && (
        <SkillsPopover
          sessionId={sessionId}
          onClose={() => setSkillOpen(false)}
          enabledConnectors={enabledConnectors}
          onToggleConnector={toggleConnector}
        />
      )}

      <form
        onSubmit={submit}
        data-testid="prompt-composer"
        className="overflow-hidden rounded-[15px] border border-[#17231b] bg-[#0c0e0c] shadow-[0_8px_30px_rgba(0,0,0,.35)]"
      >
        {/* Context-usage bar: prompt-side tokens over the model's real window. Live from
            `context_usage` while a run is turning, and the last completed run's durable figure
            when there is no live reading (reload, late join, or before the first turn). */}
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
            {tokensToK(shownTokens)} / {tokensToK(contextWindow)} · {contextPct}%
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
                      {/* Two different limits, so two different labels. "no tools" means the
                          model cannot act at all — it answers, and every tool is withheld from
                          the run. "tools, no live streaming" means it DOES run with tools
                          via the non-streaming fallback, and the only cost is no live
                          token streaming on a tools turn — stated so the pause is expected
                          rather than alarming. Only an EXPLICIT false earns either label; an
                          absent field is version skew, not a limitation. */}
                      {m.toolUse === false
                        ? `${m.label} — no tools (answers only)`
                        : m.toolUseWhileStreaming === false
                          ? `${m.label} — tools, no live streaming`
                          : m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              {/* A provider the host cannot serve, shown DISABLED with its reason and fix rather
                  than omitted. An empty picker and a missing credential are indistinguishable
                  otherwise, and the harness reports unavailable providers (never drops them) for
                  exactly this . The sentinel value is never selectable, so it can
                  never be sent. */}
              {unavailable.map((provider) => (
                <optgroup key={provider.id} label={`${provider.label} — unavailable`}>
                  <option
                    value={`unavailable:${provider.id}`}
                    disabled
                    data-testid={`model-unavailable-${provider.id}`}
                  >
                    {provider.reason ?? "unavailable"}
                    {provider.remedy ? ` — ${provider.remedy}` : ""}
                  </option>
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
              {/* Only when something is ON: a "0 connectors" badge is noise, while an enabled
                  one is a cost the participant should see without opening the panel. */}
              {enabledConnectors.length > 0 && (
                <span
                  data-testid="connectors-count"
                  className="rounded-full bg-[#0a1826] px-[6px] py-px text-[10px] font-semibold text-[#7cd992]"
                >
                  {enabledConnectors.length} mcp
                </span>
              )}
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

        {/* , at the point of action. Any participant with run permission spends the HOST
            developer's account, not their own — that is already true and multi-provider made it
            harder to see, since the same model name under two providers bills two places. Named
            here (where a run is started) and in the session header (where every role reads it). */}
        {showModeControl && (
          <p
            data-testid="composer-account-notice"
            className="px-[15px] pb-3 font-mono text-[11px] text-[#6b726b]"
          >
            Runs spend the host developer's{" "}
            {selected ? (
              <span data-testid="composer-account-provider" className="text-[#8a927c]">
                {selected.providerLabel}
              </span>
            ) : (
              "provider"
            )}{" "}
            account, not yours.
          </p>
        )}

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
