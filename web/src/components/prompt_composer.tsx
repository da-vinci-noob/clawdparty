import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { useModels } from "../hooks/use_models";
import {
  selectActiveRunId,
  selectAwaitingReviewRunId,
  selectExecutablePlanRunId,
  selectLatestUsage,
  useEventStore,
} from "../stores/event_store";
import { SkillsPopover } from "./session/skills_popover";

// The Claude permission modes a user may pick (CLI Shift+Tab). Bypass is owner-only
// (it ignores the tool whitelist); the server re-enforces every choice.
type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";
const MODE_OPTIONS: { value: PermissionMode; label: string; ownerOnly?: boolean }[] = [
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Auto-accept" },
  { value: "bypassPermissions", label: "Bypass", ownerOnly: true },
];

// Context-window size per model (tokens). Current Claude models are 200K; unknown
// models fall back to 200K. Used as the denominator of the CONTEXT bar.
const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;
const tokensToK = (n: number): string => `${Math.round(n / 1000)}K`;

// Prompt composer: starts a run when none is active, sends a follow-up when one is,
// and submits a `revise` follow-up while awaiting review. When starting a run the
// user picks Claude's permission mode + model; after a finished Plan run an "Execute
// plan" shortcut starts an auto-accept run that resumes the session. Rendered only
// for owner/editor (client gating is presentation only — the server SessionPolicy gates).
export const PromptComposer: FC<{ sessionId: string }> = ({ sessionId }) => {
  const { can } = useCurrentParticipant();
  const models = useModels();
  const activeRunId = useEventStore(selectActiveRunId);
  const reviewRunId = useEventStore(selectAwaitingReviewRunId);
  const planRunId = useEventStore(selectExecutablePlanRunId);
  // Select PRIMITIVES (not the object) so a new reference each render can't loop Zustand.
  const contextTokens = useEventStore((s) => selectLatestUsage(s)?.contextTokens ?? 0);
  const usageModel = useEventStore((s) => selectLatestUsage(s)?.model ?? null);
  const [text, setText] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("acceptEdits");
  // Empty = let the server pick its default (ANTHROPIC_MODEL). Set once the user
  // chooses; the option list itself comes from runtime discovery (useModels).
  const [model, setModel] = useState("");
  const [skillOpen, setSkillOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can("run")) {
    return null;
  }

  const revising = !activeRunId && reviewRunId !== null;

  const startRun = (prompt: string, mode: PermissionMode): Promise<Response> =>
    fetch(`/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        prompt,
        permission_mode: mode,
        ...(model ? { model } : {}),
        ...(revising ? { mode: "revise" } : {}),
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
        : await startRun(text, permissionMode);
      if (await surfaceError(res)) {
        setText("");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  // A finished Plan run made no edits; a fresh auto-accept run resumes its session
  // and executes the plan (edits then flow through changeset review).
  const executePlan = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await surfaceError(await startRun("Execute the plan you just proposed.", "acceptEdits"));
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const showModeControl = !activeRunId; // a new run is created (start or revise)
  const modeOptions = MODE_OPTIONS.filter((m) => !m.ownerOnly || can("bypass_permissions"));

  // Real context usage from the latest completed run (0 until the first run finishes).
  // Window follows that run's model, falling back to the currently-selected model.
  const contextWindow = CONTEXT_WINDOW_BY_MODEL[usageModel ?? model] ?? DEFAULT_CONTEXT_WINDOW;
  const contextPct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));

  return (
    <div className="relative z-[2] px-[18px] pb-4">
      {skillOpen && <SkillsPopover onClose={() => setSkillOpen(false)} />}

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
            {tokensToK(contextTokens)} / {tokensToK(contextWindow)} · {contextPct}%
          </span>
        </div>

        {planRunId && !activeRunId && (
          <div className="px-[15px] pt-[10px]">
            <button
              type="button"
              data-testid="execute-plan"
              onClick={() => void executePlan()}
              disabled={busy}
              className="rounded-[8px] border border-[#1c2a20] bg-[#0a1826] px-3 py-1 font-mono text-[12px] text-[#3b9dff] disabled:opacity-50"
            >
              ▶ Execute plan
            </button>
          </div>
        )}

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
          {/* model dropdown — options come from runtime discovery (useModels);
              the chosen id is sent as `model` on run start (empty = server default). */}
          {showModeControl && (
            <select
              aria-label="Model"
              data-testid="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] hover:border-[#2c5580] focus:outline-none"
            >
              <option value="">Default model</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}

          {/* MOCK skills button — allowed_tools is hardcoded server-side; toggling
              skills is not wired to the backend. */}
          <button
            type="button"
            onClick={() => setSkillOpen((v) => !v)}
            className={`flex items-center gap-[7px] rounded-[9px] border px-[11px] py-[7px] font-mono text-[12px] ${
              skillOpen
                ? "border-[#2c5580] bg-[#0a1826] text-[#3b9dff]"
                : "border-[#17231b] bg-[#0e140f] text-[#cdd2cd] hover:border-[#2c5580]"
            }`}
          >
            <span className="text-[12px]">✦</span> Skills
            <span className="rounded-full bg-[#0a1826] px-[6px] py-px text-[10px] font-semibold text-[#3b9dff]">
              3
            </span>
          </button>

          {/* permission mode — kept as the existing select (restyled) */}
          {showModeControl && (
            <select
              aria-label="Permission mode"
              data-testid="permission-mode"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
              className="rounded-[9px] border border-[#17231b] bg-[#0e140f] px-[11px] py-[7px] font-mono text-[12px] text-[#cdd2cd] hover:border-[#2c5580] focus:outline-none"
            >
              {modeOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
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
