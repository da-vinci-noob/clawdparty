import type { ChatMessagePayload, EventEnvelope } from "@clawdparty/contracts";
import { type FC, type FormEvent, useMemo, useState } from "react";
import { actorLabel } from "../helpers/participant_names";
import { selectDurableEvents, useEventStore } from "../stores/event_store";
import { useParticipantList } from "./participant_list";

// The right-sidebar chat: renders chat_message events from the store (deduped by
// id; a late joiner sees prior chat because chat is durable + backfilled), and
// sends via the Rails chat endpoint (which appends a chat_message via Events::Append).
export const ChatPanel: FC<{ sessionId: string }> = ({ sessionId }) => {
  const durable = useEventStore(selectDurableEvents);
  const names = useParticipantList();
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
    <div data-testid="chat-panel" className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-auto text-sm">
        {chats.map((e) => (
          <div key={e.id} data-testid="chat-message">
            <span className="text-neutral-500">{actorLabel(e.actor, names)}: </span>
            <span>{(e.payload as ChatMessagePayload).body}</span>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-1 pt-2">
        <input
          aria-label="Chat message"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-neutral-700 px-2 text-sm disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
};
