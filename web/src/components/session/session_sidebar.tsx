import type { FC, ReactNode } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { SessionList } from "./session_list";

// The left rail: logo, New/Join actions, the caller's real session lists (via
// SessionList → GET /api/sessions), the session's owner controls (invite / change
// dir) passed in via `ownerControls`, and a user footer.
export const SessionSidebar: FC<{ ownerControls?: ReactNode }> = ({ ownerControls }) => {
  const { participant } = useCurrentParticipant();
  const initials = (participant?.name ?? "you").slice(0, 2).toUpperCase();

  return (
    <>
      <div className="flex items-center gap-[11px] px-4 pb-[15px] pt-[18px]">
        <div
          className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] text-[16px] font-extrabold text-[#04101f]"
          style={{ background: "linear-gradient(135deg,#2166b0,#3b9dff)" }}
        >
          ▚
        </div>
        <div className="flex flex-col leading-[1.15]">
          <span className="text-[15px] font-semibold tracking-[-0.2px]">
            clawd<span className="text-[#3b9dff]">party</span>
          </span>
          <span className="mt-px text-[10px] tracking-[0.4px] text-[#6b726b]">
            shared ai sessions
          </span>
        </div>
      </div>

      <div className="flex gap-2 px-[14px] pb-[14px]">
        <a
          href="/"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] bg-[#3b9dff] px-[10px] py-[9px] text-[13px] font-semibold text-[#04101f] shadow-[0_0_16px_rgba(59,157,255,.3)] transition hover:brightness-110"
        >
          <span className="text-[15px] leading-none">+</span> New
        </a>
        <a
          href="/"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] border border-[#1c2a20] px-[10px] py-[9px] text-[13px] font-medium text-[#cdd2cd] transition hover:border-[#2c5580]"
        >
          Join
        </a>
      </div>

      <SessionList />

      {ownerControls && (
        <div className="mx-[14px] mb-4 space-y-3 border-t border-[#16211a] pt-4">
          {ownerControls}
        </div>
      )}

      <div className="flex items-center gap-[10px] border-t border-[#16211a] px-4 py-3">
        <div className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-[#0e140f] font-mono text-[11px] font-semibold text-[#cdd2cd]">
          {initials}
        </div>
        <div className="flex min-w-0 flex-1 flex-col leading-[1.2]">
          <span className="truncate text-[12px] font-medium">{participant?.name ?? "you"}</span>
          <span className="text-[10px] capitalize text-[#6b726b]">
            {participant?.role ?? "guest"} · online
          </span>
        </div>
        <span
          className="h-[7px] w-[7px] rounded-full bg-[#3b9dff]"
          style={{ boxShadow: "0 0 8px rgba(59,157,255,.85)" }}
        />
      </div>
    </>
  );
};
