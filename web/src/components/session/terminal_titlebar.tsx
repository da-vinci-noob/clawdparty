import type { FC } from "react";
import { useMemo } from "react";
import { avatarColor, initialsOf } from "../../helpers/avatar";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { selectDurableEvents, useEventStore } from "../../stores/event_store";

interface ParticipantJoinedPayload {
  participant_id?: string;
  name?: string;
}

// The center pane's terminal-style titlebar: window dots, the working path, the
// stack of participant avatars, and a live-participant count. Avatars are real
// (derived from participant_joined events); presence beyond "joined" is not
// tracked server-side, so the count is the number of known participants.
export const TerminalTitlebar: FC<{ path?: string }> = ({ path }) => {
  const durable = useEventStore(selectDurableEvents);
  const { participant } = useCurrentParticipant();

  // Shell-style prompt: "<display name>@clawdparty : <working directory>". The dir
  // is the session's selected directory (shown as its folder name); falls back to
  // the `path` prop / a placeholder before the participant is hydrated.
  const promptUser = participant?.name?.trim() || "clawd";
  const dir = participant?.repository_path?.trim() || path?.trim() || "";
  const workspace = dir ? (dir.split("/").filter(Boolean).at(-1) ?? dir) : "~/workspace";

  const participants = useMemo(() => {
    const list: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const e of durable) {
      if (e.type !== "participant_joined") {
        continue;
      }
      const p = e.payload as ParticipantJoinedPayload;
      if (p.participant_id && !seen.has(p.participant_id)) {
        seen.add(p.participant_id);
        list.push({ id: p.participant_id, name: p.name ?? `#${p.participant_id}` });
      }
    }
    return list;
  }, [durable]);

  const shown = participants.slice(0, 4);

  return (
    <div className="relative z-[1] flex min-w-0 items-center gap-3 overflow-hidden border-b border-[#16211a] bg-[#0b0d0b] px-[18px] py-[13px]">
      <div className="flex flex-none gap-[7px]">
        <span className="h-[11px] w-[11px] rounded-full bg-[#3a4440]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#3a4440]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#3a4440]" />
      </div>
      <div className="ml-1 flex min-w-0 items-center gap-2 font-mono text-[13px]">
        <span data-testid="titlebar-prompt" className="flex-none text-[#6b726b]">
          {promptUser}@clawdparty
        </span>
        <span className="flex-none text-[#3a4440]">:</span>
        <span
          data-testid="titlebar-workspace"
          className="min-w-0 truncate text-[#3b9dff]"
          style={{ textShadow: "0 0 12px rgba(59,157,255,.4)" }}
        >
          {workspace}
        </span>
        <span
          className="ml-[2px] h-[6px] w-[6px] flex-none rounded-full bg-[#3b9dff]"
          style={{ boxShadow: "0 0 8px rgba(59,157,255,.85)" }}
        />
      </div>
      <div className="flex-1" />
      {shown.length > 0 && (
        <div className="flex items-center">
          {shown.map((p, i) => {
            const c = avatarColor(p.id);
            return (
              <div
                key={p.id}
                title={p.name}
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#0b0d0b] font-mono text-[9px] font-semibold"
                style={{ background: c.bg, color: c.color, marginLeft: i === 0 ? 0 : -7 }}
              >
                {initialsOf(p.name)}
              </div>
            );
          })}
        </div>
      )}
      <span className="ml-1 flex-none font-mono text-[11px] text-[#6b726b]">
        {participants.length} {participants.length === 1 ? "here" : "live"}
      </span>
    </div>
  );
};
