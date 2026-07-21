import type { ChatMessagePayload, EventEnvelope } from "@clawdparty/contracts";
import { type FC, type FormEvent, useMemo, useState } from "react";
import { avatarColor, initialsOf } from "../helpers/avatar";
import { actorLabel } from "../helpers/participant_names";
import { selectDurableEvents, useEventStore } from "../stores/event_store";
import { useJoinedParticipants, useParticipantList } from "./participant_list";

// The right-sidebar room chat: renders chat_message events from the store (deduped
// by id; a late joiner sees prior chat because chat is durable + backfilled), and
// sends via the Rails chat endpoint (which appends a chat_message via Events::Append).
// Styled to the dark-green design; emoji reactions from the reference are omitted
// (no reaction model/event/route exists server-side).
export const ChatPanel: FC<{ sessionId: string }> = ({ sessionId }) => {
  const durable = useEventStore(selectDurableEvents);
  const names = useParticipantList();
  const participants = useJoinedParticipants();
  const presence = useEventStore((s) => s.presenceByParticipant);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const chats = useMemo(
    () => durable.filter((e): e is EventEnvelope => e.type === "chat_message"),
    [durable],
  );

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!text.trim()) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ body: text }),
      });
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="chat-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#16211a] px-4 pb-[14px] pt-4">
        <div className="flex items-center gap-[9px]">
          <span className="text-[14px] font-semibold">Room chat</span>
          <span
            className="h-[6px] w-[6px] rounded-full bg-[#3b9dff]"
            style={{ boxShadow: "0 0 8px rgba(59,157,255,.85)" }}
          />
        </div>
        <span className="font-mono text-[11px] text-[#6b726b]">{participants.length} here</span>
      </div>

      {participants.length > 0 && (
        <div data-testid="participant-roster" className="border-b border-[#16211a] px-[14px] py-3">
          <div className="mb-[10px] font-mono text-[10px] uppercase tracking-[0.08em] text-[#5c6b5f]">
            In this room
          </div>
          <ul className="flex max-h-[168px] flex-col gap-2 overflow-y-auto">
            {participants.map((p) => {
              const c = avatarColor(p.id);
              const online = presence.get(p.id) === true;
              return (
                <li
                  key={p.id}
                  data-testid="roster-participant"
                  className="flex items-center gap-[10px]"
                >
                  <div className="relative flex-none">
                    <div
                      className="flex h-7 w-7 items-center justify-center rounded-full font-mono text-[10px] font-semibold"
                      style={{ background: c.bg, color: c.color }}
                    >
                      {initialsOf(p.name)}
                    </div>
                    <span
                      title={online ? "online" : "offline"}
                      className="absolute -bottom-px -right-px h-[9px] w-[9px] rounded-full border-2 border-[#0b0d0b]"
                      style={{ background: online ? "#34d17d" : "#3a4440" }}
                    />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[#cdd2cd]">
                    {p.name}
                  </span>
                  {p.role && (
                    <span className="flex-none font-mono text-[10px] lowercase text-[#5c6b5f]">
                      {p.role}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-[17px] overflow-y-auto px-[14px] py-4">
        {chats.map((e) => {
          const label = actorLabel(e.actor, names);
          const id = e.actor.kind === "user" && e.actor.id ? String(e.actor.id) : label;
          const isClaude = e.actor.kind === "claude";
          const c = avatarColor(id);
          return (
            <div key={e.id} data-testid="chat-message" className="flex gap-[10px]">
              <div
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full font-mono text-[10px] font-semibold"
                style={
                  isClaude
                    ? { background: "#0a1826", color: "#3b9dff" }
                    : { background: c.bg, color: c.color }
                }
              >
                {isClaude ? "✦" : initialsOf(label)}
              </div>
              <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[12px] font-medium text-[#cdd2cd]">{label}</span>
                <span className="text-[13px] leading-[1.5] text-[#cdd2cd]">
                  {(e.payload as ChatMessagePayload).body}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={send} className="border-t border-[#16211a] px-[14px] py-3">
        <div className="flex items-center gap-[9px] rounded-[11px] border border-[#17231b] bg-[#0e120f] px-3 py-[10px]">
          <input
            aria-label="Chat message"
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            placeholder="Message the room…"
            className="flex-1 bg-transparent text-[13px] text-[#e6e8e6] placeholder:text-[#5c6b5f] focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            aria-label="Send"
            className="text-[13px] text-[#6b726b] hover:text-[#3b9dff] disabled:opacity-50"
          >
            ↵
          </button>
        </div>
      </form>
    </div>
  );
};
