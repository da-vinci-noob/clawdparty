import type { FC } from "react";
import { useMemo } from "react";
import type { ParticipantNames } from "../helpers/participant_names";
import { selectDurableEvents, useEventStore } from "../stores/event_store";

interface ParticipantJoinedPayload {
  participant_id?: string;
  name?: string;
  role?: string;
}

// Build the (participant_id → name) map from participant_joined events, for
// actor attribution elsewhere (chat, banners).
export function useParticipantList(): ParticipantNames {
  const durable = useEventStore(selectDurableEvents);
  return useMemo(() => {
    const names: ParticipantNames = new Map();
    for (const e of durable) {
      if (e.type === "participant_joined") {
        const p = e.payload as ParticipantJoinedPayload;
        if (p.participant_id && p.name) {
          names.set(p.participant_id, p.name);
        }
      }
    }
    return names;
  }, [durable]);
}

// The participant list with a minimal online/offline indicator from the
// last-writer-wins presence_changed map. Presence beyond this stub is out of scope.
export const ParticipantList: FC = () => {
  const durable = useEventStore(selectDurableEvents);
  const presence = useEventStore((s) => s.presenceByParticipant);

  const participants = useMemo(() => {
    const list: { id: string; name: string; role: string }[] = [];
    const seen = new Set<string>();
    for (const e of durable) {
      if (e.type !== "participant_joined") {
        continue;
      }
      const p = e.payload as ParticipantJoinedPayload;
      if (p.participant_id && !seen.has(p.participant_id)) {
        seen.add(p.participant_id);
        list.push({ id: p.participant_id, name: p.name ?? `#${p.participant_id}`, role: p.role ?? "" });
      }
    }
    return list;
  }, [durable]);

  return (
    <ul data-testid="participant-list" className="space-y-1 text-xs">
      {participants.map((p) => (
        <li key={p.id} className="flex items-center gap-2">
          <span className={presence.get(p.id) ? "text-emerald-400" : "text-neutral-600"}>●</span>
          <span>{p.name}</span>
          {p.role && <span className="text-neutral-500">({p.role})</span>}
        </li>
      ))}
    </ul>
  );
};
