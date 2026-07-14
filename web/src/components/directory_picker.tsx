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
        <p className="text-xs text-red-400">{error}</p>
        <input
          aria-label={label}
          data-testid="directory-fallback"
          placeholder="Working directory (relative to repo root)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="directory-picker"
      className="space-y-2 rounded border border-neutral-700 bg-neutral-900 p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-neutral-400" data-testid="directory-current">
          {current === "" ? "(repo root)" : `/${current}`}
        </span>
        <button
          type="button"
          aria-label="Up"
          onClick={() => setCurrent(parentOf(current))}
          disabled={current === ""}
          className="rounded border border-neutral-700 px-2 py-0.5 text-xs disabled:opacity-40"
        >
          Up
        </button>
      </div>
      <ul className="max-h-40 space-y-1 overflow-auto">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              data-testid="dir-entry"
              aria-label={`Open ${entry.name}`}
              onClick={() => setCurrent(entry.path)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-neutral-800"
            >
              <span className="truncate">{entry.name}</span>
              {entry.is_git_repo && (
                <span className="rounded bg-neutral-800 px-1 text-[10px] uppercase text-neutral-400">
                  git
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange(current)}
        className="w-full rounded bg-sky-600 px-2 py-1 text-sm"
      >
        Use this folder
      </button>
    </div>
  );
};
