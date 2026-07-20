import { type FC, useState } from "react";

// ⚠️ MOCK — the sidecar's allowed_tools is hardcoded (Read/Write/Edit/Bash) and
// there is no skills/tool-toggle API. This popover is a visual placeholder: the
// toggles keep local state only and are NOT sent to the backend. Wire to a real
// allowed_tools param on run start when that exists.
interface Skill {
  icon: string;
  name: string;
  desc: string;
  on: boolean;
}

const INITIAL: Record<string, Skill[]> = {
  Tools: [
    { icon: "◈", name: "web-search", desc: "Search the web for context", on: true },
    { icon: "⛁", name: "code-interpreter", desc: "Run code in a sandbox", on: true },
    { icon: "⎘", name: "file-edit", desc: "Read & edit repo files", on: true },
  ],
  Connectors: [
    { icon: "▲", name: "Amplitude", desc: "Product analytics & funnels", on: false },
    { icon: "◇", name: "Linear", desc: "Issues & projects", on: false },
    { icon: "⬡", name: "GitHub", desc: "PRs, issues, code search", on: false },
  ],
};

const TABS = Object.keys(INITIAL);
const FIRST_TAB = TABS[0] ?? "Tools";

export const SkillsPopover: FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<string>(FIRST_TAB);
  const [skills, setSkills] = useState(INITIAL);
  const rows = skills[tab] ?? [];

  const toggle = (name: string): void =>
    setSkills((prev) => ({
      ...prev,
      [tab]: (prev[tab] ?? []).map((s: Skill) => (s.name === name ? { ...s, on: !s.on } : s)),
    }));

  return (
    <div className="mb-[10px] overflow-hidden rounded-[13px] border border-[#17231b] bg-[#0c0e0c] shadow-[0_12px_40px_rgba(0,0,0,.45)]">
      <div className="flex items-center gap-[2px] px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-[8px] px-[11px] py-[6px] font-mono text-[12px] ${
              t === tab ? "bg-[#0e140f] text-[#3b9dff]" : "text-[#7c847c] hover:text-[#aeb4ae]"
            }`}
          >
            {t}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close skills"
          className="px-2 py-[6px] font-mono text-[12px] text-[#6b726b] hover:text-[#aeb4ae]"
        >
          ✕
        </button>
      </div>
      <div className="max-h-[220px] overflow-y-auto px-3 pb-[14px] pt-[10px]">
        {rows.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => toggle(s.name)}
            className="flex w-full items-center justify-between rounded-[9px] px-[10px] py-[9px] text-left hover:bg-[#0e140f]"
          >
            <span className="flex min-w-0 items-center gap-[11px]">
              <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[8px] border border-[#1c2a20] bg-[#0e140f] text-[12px] text-[#3b9dff]">
                {s.icon}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-[13px] text-[#e6e8e6]">{s.name}</span>
                <span className="truncate text-[11px] text-[#6b726b]">{s.desc}</span>
              </span>
            </span>
            <span
              className="flex h-[18px] w-[30px] flex-none items-center rounded-full px-[2px] transition"
              style={{ background: s.on ? "#1d3652" : "#16211a" }}
            >
              <span
                className="h-[14px] w-[14px] rounded-full transition"
                style={{
                  background: s.on ? "#3b9dff" : "#6b726b",
                  marginLeft: s.on ? 12 : 0,
                }}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
