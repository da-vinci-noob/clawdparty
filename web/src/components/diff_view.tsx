import { type FC, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import "./diff_view.css";
import { useCurrentParticipant } from "../hooks/use_current_participant";
import { ReviewControls } from "./review_controls";

// One changed file as reported by GET /api/runs/:id/diff (Git::Diff#to_h). A
// binary file has null insertions/deletions.
interface DiffFile {
  path: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

interface DiffResponse {
  run_id: string;
  base_sha: string;
  files: DiffFile[];
  patch: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: DiffResponse };

type ParsedFile = ReturnType<typeof parseDiff>[number];

// Single-letter change-type badge (matching the design's diff card), from
// react-diff-view's parsed file type.
const TYPE_BADGE: Record<string, string> = {
  add: "A",
  delete: "D",
  modify: "M",
  rename: "R",
  copy: "C",
};

// The review pane for a run awaiting review. Fetches the run's diff over REST
// (never the cable — the diff can be large; frozen http-api invariant) and renders
// the file list + the unified `patch` via react-diff-view. Visible to ALL roles
// (the endpoint is :view-gated); the role-gated approve/reject controls self-hide
// for viewers (owner/editor/reviewer can approve).
export const DiffView: FC<{ runId: string }> = ({ runId }) => {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/runs/${runId}/diff`, { credentials: "include" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            errors?: { message: string }[];
          } | null;
          if (!cancelled) {
            setState({
              status: "error",
              message: body?.errors?.[0]?.message ?? `Failed to load diff (${res.status})`,
            });
          }
          return;
        }
        const data = (await res.json()) as DiffResponse;
        if (!cancelled) {
          setState({ status: "loaded", data });
        }
      } catch {
        if (!cancelled) {
          setState({ status: "error", message: "Network error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <div data-testid="diff-view" className="space-y-3">
      {renderBody(state, runId)}
    </div>
  );
};

function renderBody(state: LoadState, runId: string): ReactNode {
  if (state.status === "loading") {
    return (
      <p data-testid="diff-loading" className="text-sm text-[#7c847c]">
        Loading diff…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p data-testid="diff-error" className="text-sm text-[#f0a8a8]">
        {state.message}
      </p>
    );
  }
  return <DiffBody data={state.data} runId={runId} />;
}

// The path react-diff-view reports for a parsed file (new path, or old path for a
// deletion) — the key that ties a file-list row to its collapsible patch section.
function parsedPath(file: ParsedFile): string {
  return file.newPath || file.oldPath;
}

// The loaded diff: a header with change totals, a clickable file-list summary, one
// collapsible card per file, then the approve/reject footer. Clicking a
// list row scrolls to (and expands) that file's card; clicking a card header toggles
// it. Collapse state lives here so it survives re-renders but resets when the run
// changes (DiffBody remounts per DiffView runId fetch).
const DiffBody: FC<{ data: DiffResponse; runId: string }> = ({ data, runId }) => {
  const { can } = useCurrentParticipant();
  const { files, patch } = data;
  const parsed = patch.trim() ? parseDiff(patch) : [];
  // Per-path stats from the API's numstat, so each card header can show +/−.
  const statByPath = new Map(files.map((f) => [f.path, f]));
  const totalInsertions = files.reduce((sum, f) => sum + (f.insertions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  // Collapsed set keyed by parsed path; absence = expanded (files open by default).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const setAll = useCallback(
    (collapse: boolean) => {
      setCollapsed(collapse ? new Set(parsed.map(parsedPath)) : new Set());
    },
    [parsed],
  );

  // Jump to a file's card: expand it (if collapsed) then scroll it in.
  const jumpTo = useCallback((path: string) => {
    setCollapsed((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (files.length === 0 && parsed.length === 0) {
    return (
      <p data-testid="diff-empty" className="text-sm text-[#7c847c]">
        No changes to review.
      </p>
    );
  }

  const allCollapsed = parsed.length > 0 && parsed.every((f) => collapsed.has(parsedPath(f)));

  return (
    <>
      {/* Header: title + change totals + collapse/expand-all toggle. */}
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="text-xs font-semibold text-[#aeb4ae]">Review changes</h3>
          <span data-testid="diff-summary" className="font-mono text-[11px] text-[#6b726b]">
            {files.length} {files.length === 1 ? "file" : "files"}{" "}
            <span className="text-[#3b9dff]">+{totalInsertions}</span>{" "}
            <span className="text-[#f0a8a8]">−{totalDeletions}</span>
          </span>
        </div>
        {parsed.length > 1 && (
          <button
            type="button"
            data-testid="diff-collapse-all"
            onClick={() => setAll(!allCollapsed)}
            className="rounded-[7px] border border-[#17231b] bg-[#0e140f] px-[9px] py-[4px] font-mono text-[10px] uppercase tracking-[0.06em] text-[#7c847c] transition hover:border-[#2c5580] hover:text-[#cdd2cd]"
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {/* File-list summary: accent chips that jump to each file's card. */}
      <ul data-testid="diff-file-list" className="flex flex-wrap gap-[6px]">
        {files.map((file) => (
          <li key={file.path} data-testid="diff-file">
            <button
              type="button"
              data-testid="diff-file-jump"
              onClick={() => jumpTo(file.path)}
              className="flex items-center gap-[7px] rounded-[7px] border border-[#1d3652] bg-[#0a1826] px-[9px] py-[5px] transition hover:border-[#2c5580]"
            >
              <span className="truncate font-mono text-[11px] text-[#b8dcff]">{file.path}</span>
              {file.binary ? (
                <span className="shrink-0 font-mono text-[10px] text-[#7c847c]">binary</span>
              ) : (
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  <span className="text-[#3b9dff]">+{file.insertions ?? 0}</span>{" "}
                  <span className="text-[#f0a8a8]">−{file.deletions ?? 0}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {/* One card per file: header (badge · path · stats · caret) + tinted diff.
          No fixed height / inner scrollbar — the card is exactly as tall as the
          diff and scrolls inline with the center pane (not pinned), so scrolling
          past it reveals the activity feed rather than hiding it behind a fixed box. */}
      <div data-testid="diff-patch" className="space-y-3">
        {parsed.map((file) => {
          const path = parsedPath(file);
          const isCollapsed = collapsed.has(path);
          const stat = statByPath.get(path);
          const badge = TYPE_BADGE[file.type] ?? "M";
          return (
            <div
              key={`${file.oldRevision}:${file.newRevision}:${path}`}
              data-testid="diff-patch-file"
              ref={(el) => {
                if (el) {
                  sectionRefs.current.set(path, el);
                } else {
                  sectionRefs.current.delete(path);
                }
              }}
              className="overflow-hidden rounded-[10px] border border-[#17231b] bg-[#0c0e0c]"
            >
              <button
                type="button"
                data-testid="diff-patch-header"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(path)}
                className="flex w-full items-center gap-[10px] border-b border-[#16211a] bg-[#0b0d0b] px-[13px] py-[10px] text-left transition hover:bg-[#0e140f]"
              >
                <span
                  aria-hidden="true"
                  className="w-2.5 shrink-0 text-[10px] text-[#6b726b] transition-transform duration-200"
                  style={{ transform: isCollapsed ? "rotate(-90deg)" : "none" }}
                >
                  ▾
                </span>
                <span className="shrink-0 rounded-[4px] bg-[#1c2a20] px-[6px] py-[1px] font-mono text-[11px] font-bold text-[#3b9dff]">
                  {badge}
                </span>
                <span className="flex-1 truncate font-mono text-[12px] text-[#cdd2cd]">{path}</span>
                {stat &&
                  (stat.binary ? (
                    <span className="shrink-0 font-mono text-[11px] text-[#7c847c]">binary</span>
                  ) : (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      <span className="text-[#3b9dff]">+{stat.insertions ?? 0}</span>{" "}
                      <span className="text-[#f0a8a8]">−{stat.deletions ?? 0}</span>
                    </span>
                  ))}
              </button>
              {!isCollapsed && (
                <div className="cp-diff cp-diff-in overflow-auto text-xs">
                  <Diff
                    diffType={file.type}
                    hunks={file.hunks}
                    viewType="unified"
                    gutterType="none"
                  >
                    {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                  </Diff>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer: role hint on the left, approve/reject on the right (owner,
          editor and reviewer can approve; viewers only watch). */}
      <div className="flex items-center justify-between border-t border-[#16211a] pt-3">
        <span className="font-mono text-[12px] text-[#6b726b]">
          {can("approve") ? (
            <>
              you can <span className="font-semibold text-[#3b9dff]">approve</span> this changeset
            </>
          ) : (
            <>
              only <span className="font-semibold text-[#3b9dff]">reviewers &amp; up</span> can
              approve
            </>
          )}
        </span>
        <ReviewControls runId={runId} />
      </div>
    </>
  );
};
