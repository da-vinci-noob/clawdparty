import { BUILTIN_TOOLS } from "@clawdparty/contracts";
import { type FC, useState } from "react";
import { useConnectors } from "../../hooks/use_connectors";
import { useSkills } from "../../hooks/use_skills";

// The capabilities panel — Tools, Connectors, Skills.
//
// Tools and skills have no per-item toggle: every built-in tool and every installed skill is
// available to the run, matching how Claude Code normally works.
//
// CONNECTORS DO, and they default to OFF. Enabling one is not free: the harness connects to the
// MCP server before the first request and declares every tool it advertises, and on this host
// that measured **77 tools and ~37,500 tokens of schema across 8 servers** — spent on every turn,
// before the conversation starts. So a connector is a deliberate choice per run, not an ambient
// one, and the cost is stated rather than implied.
interface Item {
  name: string;
  desc: string;
  /** Present only for togglable items (connectors). */
  enabled?: boolean;
}

const TABS = ["Tools", "Connectors", "Skills"] as const;
type Tab = (typeof TABS)[number];

const CAPTION: Record<Tab, string> = {
  Tools: "All built-in tools are available to every run.",
  Connectors: "Off by default — each one you enable adds its tools to every turn of the run.",
  Skills: "All installed skills are available — Claude uses them as needed.",
};

interface Props {
  sessionId: string;
  onClose: () => void;
  /** Connector names enabled for the NEXT run. Owned by the composer, which sends them. */
  enabledConnectors?: readonly string[];
  onToggleConnector?: (name: string) => void;
}

export const SkillsPopover: FC<Props> = ({
  sessionId,
  onClose,
  enabledConnectors = [],
  onToggleConnector,
}) => {
  const [tab, setTab] = useState<Tab>("Tools");
  const connectors = useConnectors(sessionId);
  const skills = useSkills(sessionId);

  const items: Item[] =
    tab === "Tools"
      ? // `label`, not `id`: the ids are the harness's registry names, and one of them is
        // `str_replace_based_edit_tool` — correct, and not something to show a participant.
        BUILTIN_TOOLS.map((t) => ({ name: t.label, desc: t.description }))
      : tab === "Connectors"
        ? connectors.map((c) => ({
            name: c.name,
            desc: `${c.transport} connector`,
            enabled: enabledConnectors.includes(c.name),
          }))
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
              className="flex min-w-0 items-center gap-3 rounded-[9px] px-[10px] py-[9px]"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[13px] text-[#e6e8e6]">{it.name}</span>
                <span className="truncate text-[11px] text-[#6b726b]">{it.desc}</span>
              </div>
              {it.enabled !== undefined && (
                <button
                  type="button"
                  data-testid={`cap-toggle-${it.name}`}
                  aria-pressed={it.enabled}
                  onClick={() => onToggleConnector?.(it.name)}
                  className={`shrink-0 rounded-[7px] border px-[9px] py-[5px] font-mono text-[11px] ${
                    it.enabled
                      ? "border-[#2c5580] bg-[#0a1826] text-[#3b9dff]"
                      : "border-[#17231b] bg-[#0e140f] text-[#7c847c] hover:border-[#2c5580]"
                  }`}
                >
                  {it.enabled ? "on" : "off"}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
