import { type FC, useEffect, useState } from "react";

// Server-driven folder picker for a session's working directory. Navigation is
// internal (`current`, a repo-root-relative path; "" = repo root) and independent
// of the selection: clicking a folder row descends into it; "Use this folder"
// emits the current path via onChange. Every `current` change re-lists
// GET /api/directories?path=<current> (the frozen contract). A listing outage
// (non-ok / network error) falls back to a plain text input so picking is never
// blocked. Presentation only — the server realpath-contains every path.

interface DirectoryEntry {
  name: string;
  path: string;
  is_git_repo: boolean;
}

interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
}

const parentOf = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
};

export const DirectoryPicker: FC<{
  value: string;
  onChange: (path: string) => void;
  label?: string;
}> = ({ value, onChange, label = "Working directory" }) => {
  const [current, setCurrent] = useState(value);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/directories?path=${encodeURIComponent(current)}`, {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) {
            setError(`Could not list directories (${res.status})`);
          }
          return;
        }
        const listing = (await res.json()) as DirectoryListing;
        if (!cancelled) {
          setError(null);
          setEntries(listing.entries);
        }
      } catch {
        if (!cancelled) {
          setError("Could not list directories");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  if (error) {
    return (
      <div data-testid="directory-picker" className="space-y-1">
        <p className="text-xs text-[#b58a7d]">{error}</p>
        <input
          aria-label={label}
          data-testid="directory-fallback"
          placeholder="Working directory (relative to repo root)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-[10px] border border-[#232a25] bg-[#0b0e0c] px-[15px] py-[13px] font-mono text-sm text-[#e6ebe4] outline-none focus:border-[#4fe89a]"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="directory-picker"
      className="overflow-hidden rounded-[12px] border border-[#232a25] bg-[#0b0e0c]"
    >
      <div className="flex items-center justify-between border-b border-[#171d19] px-[13px] py-[10px]">
        <span className="truncate font-mono text-xs text-[#79817b]" data-testid="directory-current">
          {current === "" ? "(repo root)" : `/${current}`}
        </span>
        <button
          type="button"
          aria-label="Up"
          onClick={() => setCurrent(parentOf(current))}
          disabled={current === ""}
          className="rounded-[7px] border border-[#232a25] bg-[#141a16] px-[11px] py-[3px] font-mono text-[11px] text-[#a4aca6] disabled:opacity-40"
        >
          Up
        </button>
      </div>
      <ul className="max-h-[190px] space-y-1 overflow-y-auto p-[5px]">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              data-testid="dir-entry"
              aria-label={`Open ${entry.name}`}
              onClick={() => setCurrent(entry.path)}
              className="flex w-full items-center justify-between gap-2 rounded-[8px] px-[11px] py-[9px] text-left hover:bg-[#141a16]"
            >
              <span className="flex min-w-0 items-center gap-[10px]">
                <span className="font-mono text-xs text-[#4fe89a]">▸</span>
                <span className="truncate font-mono text-[13.5px] text-[#e6ebe4]">
                  {entry.name}
                </span>
              </span>
              {entry.is_git_repo && (
                <span className="rounded-[5px] border border-[#2a352d] bg-[#17241b] px-[6px] py-px font-mono text-[9px] uppercase tracking-[0.5px] text-[#4fe89a]">
                  git
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="p-[9px]">
        <button
          type="button"
          onClick={() => onChange(current)}
          className="w-full rounded-[9px] border border-[#2a352d] bg-[#141a16] p-[11px] font-mono text-[12.5px] font-semibold text-[#4fe89a] hover:bg-[#17241b]"
        >
          Use this folder
        </button>
      </div>
    </div>
  );
};
