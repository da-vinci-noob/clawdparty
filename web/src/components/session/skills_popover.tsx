import { BUILTIN_TOOLS } from "@clawdparty/contracts";
import { type FC, useState } from "react";
import { useConnectors } from "../../hooks/use_connectors";
import { useSkills } from "../../hooks/use_skills";

// A read-only panel of the capabilities available to a run — Tools, Connectors,
// and Skills. There are NO per-item toggles: every built-in tool, every
// host-configured MCP connector, and every installed skill is available to the
// run (Claude uses them as needed), matching how Claude Code normally works. The
// composer sends the enablement (all connectors + skills: "all") on run start; this
// component only displays what the host has.
interface Item {
  name: string;
  desc: string;
}

const TABS = ["Tools", "Connectors", "Skills"] as const;
type Tab = (typeof TABS)[number];

const CAPTION: Record<Tab, string> = {
  Tools: "All built-in tools are available to every run.",
  Connectors: "All host-configured MCP servers are available to every run.",
  Skills: "All installed skills are available — Claude uses them as needed.",
};

export const SkillsPopover: FC<{ sessionId: string; onClose: () => void }> = ({
  sessionId,
  onClose,
}) => {
  const [tab, setTab] = useState<Tab>("Tools");
  const connectors = useConnectors(sessionId);
  const skills = useSkills(sessionId);

  const items: Item[] =
    tab === "Tools"
      ? BUILTIN_TOOLS.map((t) => ({ name: t.id, desc: t.description }))
      : tab === "Connectors"
        ? connectors.map((c) => ({ name: c.name, desc: `${c.transport} connector` }))
        : skills.map((s) => ({ name: s.name, desc: s.description }));

  const emptyLabel =
    tab === "Connectors"
      ? "No connectors configured on the host"
      : "No skills installed on the host";

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
        <p className="px-[10px] pb-[6px] font-mono text-[11px] text-[#565d58]">{CAPTION[tab]}</p>
        {items.length === 0 ? (
          <p
            data-testid="cap-empty"
            className="px-[10px] py-[9px] font-mono text-[12px] text-[#6b726b]"
          >
            {emptyLabel}
          </p>
        ) : (
          items.map((it) => (
            <div
              key={it.name}
              data-testid={`cap-item-${it.name}`}
              className="flex min-w-0 flex-col rounded-[9px] px-[10px] py-[9px]"
            >
              <span className="font-mono text-[13px] text-[#e6e8e6]">{it.name}</span>
              <span className="truncate text-[11px] text-[#6b726b]">{it.desc}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
