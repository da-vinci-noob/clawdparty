import { type FC, type ReactNode, useState } from "react";
import { useCurrentParticipant } from "../../hooks/use_current_participant";
import { LogoMark } from "../landing/logo_mark";

// ⚠️ MOCK DATA — there is no session-list/index API today (routes expose only
// session create/update). The "Your sessions" / "Joined" lists below are static
// placeholders so the design's left rail is visible; selecting a row does nothing.
// Wire these to a real GET /api/sessions when that endpoint exists.
interface MockSession {
  name: string;
  meta: string;
  status: string;
  live?: boolean;
}
const MOCK_OWNED: MockSession[] = [
  { name: "redesign-onboarding", meta: "3 online · 12m ago", status: "live", live: true },
  { name: "billing-webhooks", meta: "you · 2h ago", status: "idle" },
  { name: "search-reindex", meta: "you · yesterday", status: "review" },
];
const MOCK_JOINED: MockSession[] = [
  { name: "growth-experiments", meta: "maya · 4m ago", status: "live", live: true },
  { name: "infra-migration", meta: "devon · 1d ago", status: "idle" },
];

const IDLE_PILL = { bg: "#161a18", color: "#79817b" };
const STATUS_PILL: Record<string, { bg: string; color: string }> = {
  live: { bg: "#17241b", color: "#4fe89a" },
  review: { bg: "#241f17", color: "#d6b784" },
  idle: IDLE_PILL,
};

const SessionRow: FC<{ s: MockSession }> = ({ s }) => {
  const pill = STATUS_PILL[s.status] ?? IDLE_PILL;
  return (
    <button
      type="button"
      className="w-full rounded-[9px] px-[11px] py-[9px] text-left transition hover:bg-[#141a16]"
    >
      <div className="flex min-w-0 items-center gap-[9px]">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={
            s.live
              ? { background: "#4fe89a", boxShadow: "0 0 8px rgba(79,232,154,.85)" }
              : { background: "#3a4038" }
          }
        />
        <span className="truncate font-mono text-[13px] font-medium">{s.name}</span>
      </div>
      <div className="mt-[6px] flex items-center justify-between pl-[17px]">
        <span className="text-[11px] text-[#565d58]">{s.meta}</span>
        <span
          className="rounded-full px-[7px] py-px font-mono text-[9px] uppercase tracking-[0.4px]"
          style={{ background: pill.bg, color: pill.color }}
        >
          {s.status}
        </span>
      </div>
    </button>
  );
};

const SectionHeader: FC<{ label: string; count: number }> = ({ label, count }) => (
  <div className="flex items-center justify-between px-[6px] pb-[6px] pt-[10px]">
    <span className="font-mono text-[10px] uppercase tracking-[1px] text-[#565d58]">{label}</span>
    <span className="font-mono text-[10px] text-[#3a4038]">{count}</span>
  </div>
);

// The left rail: logo, New/Join actions, a (mock) search + session lists, the
// session's real owner controls (invite / change dir) passed in via
// `ownerControls`, and a user footer. Only `ownerControls` is functional.
export const SessionSidebar: FC<{ ownerControls?: ReactNode }> = ({ ownerControls }) => {
  const { participant } = useCurrentParticipant();
  const [query, setQuery] = useState("");
  const initials = (participant?.name ?? "you").slice(0, 2).toUpperCase();

  return (
    <>
      <div className="flex items-center gap-[11px] px-4 pb-[15px] pt-[18px]">
        <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[#262c28] bg-[#161a18]">
          <LogoMark />
        </div>
        <div className="flex flex-col leading-[1.15]">
          <span className="text-[15px] font-semibold tracking-[-0.2px]">
            clawd<span className="text-[#4fe89a]">party</span>
          </span>
          <span className="mt-px text-[10px] tracking-[0.4px] text-[#565d58]">
            shared ai sessions
          </span>
        </div>
      </div>

      <div className="flex gap-2 px-[14px] pb-[14px]">
        <a
          href="/"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] bg-[#4fe89a] px-[10px] py-[9px] text-[13px] font-semibold text-[#0e1a13] shadow-[0_0_16px_rgba(79,232,154,.3)] transition hover:brightness-110"
        >
          <span className="text-[15px] leading-none">+</span> New
        </a>
        <a
          href="/"
          className="flex flex-1 items-center justify-center gap-[6px] rounded-[9px] border border-[#262c28] px-[10px] py-[9px] text-[13px] font-medium text-[#d4dbd2] transition hover:border-[#374039]"
        >
          Join
        </a>
      </div>

      {/* MOCK search — non-functional filter over placeholder rows */}
      <div className="px-[14px] pb-2">
        <div className="flex items-center gap-2 rounded-[9px] border border-[#1d221f] bg-[#0c0f0e] px-[11px] py-[9px]">
          <span className="text-[12px] text-[#565d58]">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search or paste token…"
            className="w-full bg-transparent font-mono text-[12px] text-[#d4dbd2] placeholder:text-[#565d58] focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[10px] pb-4 pt-2">
        <SectionHeader label="Your sessions" count={MOCK_OWNED.length} />
        {MOCK_OWNED.filter((s) => s.name.includes(query.trim())).map((s) => (
          <SessionRow key={s.name} s={s} />
        ))}
        <SectionHeader label="Joined" count={MOCK_JOINED.length} />
        {MOCK_JOINED.filter((s) => s.name.includes(query.trim())).map((s) => (
          <SessionRow key={s.name} s={s} />
        ))}

        {ownerControls && (
          <div className="mt-4 space-y-3 border-t border-[#1d221f] pt-4">{ownerControls}</div>
        )}
      </div>

      <div className="flex items-center gap-[10px] border-t border-[#1d221f] px-4 py-3">
        <div className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-[#414d47] font-mono text-[11px] font-semibold text-[#d7ded9]">
          {initials}
        </div>
        <div className="flex min-w-0 flex-1 flex-col leading-[1.2]">
          <span className="truncate text-[12px] font-medium">{participant?.name ?? "you"}</span>
          <span className="text-[10px] capitalize text-[#565d58]">
            {participant?.role ?? "guest"} · online
          </span>
        </div>
        <span
          className="h-[7px] w-[7px] rounded-full bg-[#4fe89a]"
          style={{ boxShadow: "0 0 8px rgba(79,232,154,.85)" }}
        />
      </div>
    </>
  );
};
