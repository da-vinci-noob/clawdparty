import type { FC } from "react";
import { Link } from "react-router-dom";
import { SessionList } from "../components/session/session_list";

// The dedicated sessions view (route /sessions), reached from the header "sessions"
// link — NOT embedded in the landing marketing page. Left panel: New/Join actions +
// the caller's real grouped session list (Your sessions / Joined, active/revoked
// badges, owner end-session). Right: a placeholder prompting the user to open one.
export const SessionsPage: FC = () => (
  <div
    className="font-mono grid h-screen w-screen overflow-hidden bg-[#0a0a0a] text-[#e6e8e6]"
    style={{ gridTemplateColumns: "300px 1fr" }}
  >
    <aside
      aria-label="Sessions sidebar"
      className="flex min-h-0 min-w-0 flex-col border-r border-[#16211a] bg-[#0b0d0b]"
    >
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
        <Link
          to="/?tab=create"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] bg-[#3b9dff] px-[10px] py-[9px] text-[13px] font-semibold text-[#04101f] shadow-[0_0_16px_rgba(59,157,255,.3)] transition hover:brightness-110"
        >
          <span className="text-[15px] leading-none">+</span> New
        </Link>
        <Link
          to="/?tab=join"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] border border-[#1c2a20] px-[10px] py-[9px] text-[13px] font-medium text-[#cdd2cd] transition hover:border-[#2c5580]"
        >
          Join
        </Link>
      </div>

      <SessionList />
    </aside>

    <main aria-label="Session detail" className="grid place-items-center bg-[#0a0a0a]">
      <div className="max-w-[42ch] space-y-2 text-center">
        <h1 className="text-lg font-semibold">Your sessions</h1>
        <p className="text-sm text-[#a4aca6]">
          Pick a session from the left to open it, start a new one, or join with an invite link.
        </p>
      </div>
    </main>
  </div>
);
