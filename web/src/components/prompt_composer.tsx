import { type FC, type FormEvent, useState } from "react";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { useModels } from "../hooks/use_models";
import {
  selectActiveRunId,
  selectAwaitingReviewRunId,
  selectExecutablePlanRunId,
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

  return (
    <div className="relative z-[2] px-[18px] pb-4">
      {skillOpen && <SkillsPopover onClose={() => setSkillOpen(false)} />}

      <form
        onSubmit={submit}
        data-testid="prompt-composer"
        className="overflow-hidden rounded-[15px] border border-[#232a25] bg-[#0f1311] shadow-[0_8px_30px_rgba(0,0,0,.35)]"
      >
        {/* MOCK context-usage bar — AiRun.usage exists server-side but is never
            populated or surfaced, so these numbers are static placeholders. */}
        <div className="flex items-center gap-[10px] px-[15px] pt-[10px]">
          <span className="font-mono text-[10px] tracking-[0.5px] text-[#565d58]">CONTEXT</span>
          <div className="h-1 flex-1 overflow-hidden rounded-[3px] bg-[#181e1a]">
            <div
              className="h-full rounded-[3px] bg-[#4fe89a]"
              style={{ width: "62%", boxShadow: "0 0 10px rgba(79,232,154,.55)" }}
            />
          </div>
          <span className="font-mono text-[10px] text-[#79817b]">124K / 200K · 62%</span>
        </div>

        {planRunId && !activeRunId && (
          <div className="px-[15px] pt-[10px]">
            <button
              type="button"
              data-testid="execute-plan"
              onClick={() => void executePlan()}
              disabled={busy}
              className="rounded-[8px] border border-[#2a352d] bg-[#17241b] px-3 py-1 font-mono text-[12px] text-[#4fe89a] disabled:opacity-50"
            >
              ▶ Execute plan
            </button>
          </div>
        )}

        {/* prompt input row */}
        <div className="flex items-center gap-[10px] px-[15px] py-[10px] font-mono text-[14px]">
          <span
            className="text-[#4fe89a]"
            style={{
              animation: "cp-blink 1.1s step-end infinite",
              textShadow: "0 0 10px rgba(79,232,154,.5)",
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
            className="flex-1 bg-transparent text-[#e6ebe4] placeholder:text-[#4b524d] focus:outline-none"
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
              className="rounded-[9px] border border-[#232a25] bg-[#141a16] px-[11px] py-[7px] font-mono text-[12px] text-[#d4dbd2] hover:border-[#374039] focus:outline-none"
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
                ? "border-[#374039] bg-[#17241b] text-[#4fe89a]"
                : "border-[#232a25] bg-[#141a16] text-[#d4dbd2] hover:border-[#374039]"
            }`}
          >
            <span className="text-[12px]">✦</span> Skills
            <span className="rounded-full bg-[#1a281e] px-[6px] py-px text-[10px] font-semibold text-[#4fe89a]">
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
              className="rounded-[9px] border border-[#232a25] bg-[#141a16] px-[11px] py-[7px] font-mono text-[12px] text-[#d4dbd2] hover:border-[#374039] focus:outline-none"
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
            className="flex items-center gap-[7px] rounded-[10px] bg-[#4fe89a] px-[15px] py-[8px] font-mono text-[12px] font-semibold text-[#0e1a13] shadow-[0_0_16px_rgba(79,232,154,.35)] transition hover:brightness-110 disabled:opacity-50"
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
            className="px-[15px] pb-3 font-mono text-[12px] text-[#b58a7d]"
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
};
