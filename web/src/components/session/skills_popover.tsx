import { BUILTIN_TOOLS } from "@clawdparty/contracts";
import { type FC, useState } from "react";
import { useConnectors } from "../../hooks/use_connectors";
import { useSkills } from "../../hooks/use_skills";

// The per-run capability selection, lifted to the composer (this popover is
// controlled — it owns no throwaway state). Fields mirror the run-start body:
// `disallowed_tools` = built-in tool ids toggled OFF (default: none → all ON),
// `connectors`/`skills` = names toggled ON (default: none). All default so an
// untouched run behaves exactly as before.
export interface CapabilitySelection {
  disallowed_tools: string[];
  connectors: string[];
  skills: string[];
}

export const EMPTY_CAPABILITIES: CapabilitySelection = {
  disallowed_tools: [],
  connectors: [],
  skills: [],
};

interface Row {
  name: string;
  desc: string;
  on: boolean;
}

const TABS = ["Tools", "Connectors", "Skills"] as const;
type Tab = (typeof TABS)[number];

// Real discovered lists (tools are the fixed contract constant; connectors +
// skills come from host discovery, empty until they resolve / when unavailable).
// The Tools/Connectors/Skills surface: tools default ON (OFF → disallowed_tools),
// connectors + skills default OFF (ON → their name arrays). Selection is lifted to
// the composer via `value`/`onChange`; this popover renders + toggles only.
export const SkillsPopover: FC<{
  sessionId: string;
  value: CapabilitySelection;
  onChange: (next: CapabilitySelection) => void;
  onClose: () => void;
}> = ({ sessionId, value, onChange, onClose }) => {
  const [tab, setTab] = useState<Tab>("Tools");
  const connectors = useConnectors(sessionId);
  const skills = useSkills(sessionId);

  const toolRows: Row[] = BUILTIN_TOOLS.map((t) => ({
    name: t.id,
    desc: t.description,
    on: !value.disallowed_tools.includes(t.id),
  }));
  const connectorRows: Row[] = connectors.map((c) => ({
    name: c.name,
    desc: `${c.transport} connector`,
    on: value.connectors.includes(c.name),
  }));
  const skillRows: Row[] = skills.map((s) => ({
    name: s.name,
    desc: s.description,
    on: value.skills.includes(s.name),
  }));

  // Toggling a tool OFF puts its id in disallowed_tools (ON removes it). Toggling a
  // connector/skill ON puts its name in that array (OFF removes it).
  const toggleTool = (id: string): void => {
    const currentlyOn = !value.disallowed_tools.includes(id);
    onChange({
      ...value,
      disallowed_tools: currentlyOn
        ? [...value.disallowed_tools, id]
        : value.disallowed_tools.filter((x) => x !== id),
    });
  };
  const toggleName = (key: "connectors" | "skills", name: string): void => {
    const on = value[key].includes(name);
    onChange({
      ...value,
      [key]: on ? value[key].filter((x) => x !== name) : [...value[key], name],
    });
  };

  const rows = tab === "Tools" ? toolRows : tab === "Connectors" ? connectorRows : skillRows;
  const emptyLabel =
    tab === "Connectors"
      ? "No connectors configured on the host"
      : "No skills installed on the host";
  const toggle = (name: string): void => {
    if (tab === "Tools") {
      toggleTool(name);
    } else if (tab === "Connectors") {
      toggleName("connectors", name);
    } else {
      toggleName("skills", name);
    }
  };

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
        {rows.length === 0 ? (
          <p
            data-testid="cap-empty"
            className="px-[10px] py-[9px] font-mono text-[12px] text-[#6b726b]"
          >
            {emptyLabel}
          </p>
        ) : (
          rows.map((s) => (
            <button
              key={s.name}
              type="button"
              data-testid={`cap-toggle-${s.name}`}
              aria-pressed={s.on}
              onClick={() => toggle(s.name)}
              className="flex w-full items-center justify-between rounded-[9px] px-[10px] py-[9px] text-left hover:bg-[#0e140f]"
            >
              <span className="flex min-w-0 items-center gap-[11px]">
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
          ))
        )}
      </div>
    </div>
  );
};
