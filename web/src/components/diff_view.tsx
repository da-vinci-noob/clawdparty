import { type FC, type ReactNode, useEffect, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import "./diff_view.css";
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

// The review pane for a run awaiting review. Fetches the run's diff over REST
// (never the cable — the diff can be large; frozen http-api invariant) and renders
// the file list + the unified `patch` via react-diff-view. Visible to ALL roles
// (the endpoint is :view-gated); the owner-only approve/reject controls self-hide.
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
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[#aeb4ae]">Review changes</h3>
        <ReviewControls runId={runId} />
      </div>
      {renderBody(state)}
    </div>
  );
};

function renderBody(state: LoadState): ReactNode {
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

  const { files, patch } = state.data;
  const parsed = patch.trim() ? parseDiff(patch) : [];
  if (files.length === 0 && parsed.length === 0) {
    return (
      <p data-testid="diff-empty" className="text-sm text-[#7c847c]">
        No changes to review.
      </p>
    );
  }

  return (
    <>
      <ul data-testid="diff-file-list" className="space-y-1 text-sm">
        {files.map((file) => (
          <li
            key={file.path}
            data-testid="diff-file"
            className="flex items-center justify-between rounded border border-[#17231b] bg-[#0c0e0c] px-2 py-1"
          >
            <span className="truncate font-mono text-[#cdd2cd]">{file.path}</span>
            {file.binary ? (
              <span className="shrink-0 text-[#7c847c]">binary</span>
            ) : (
              <span className="shrink-0 tabular-nums">
                <span className="text-[#3b9dff]">+{file.insertions ?? 0}</span>{" "}
                <span className="text-[#f0a8a8]">−{file.deletions ?? 0}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div
        data-testid="diff-patch"
        className="overflow-auto rounded border border-[#17231b] text-xs"
      >
        {parsed.map((file) => (
          <div key={`${file.oldRevision}:${file.newRevision}:${file.newPath || file.oldPath}`}>
            <div className="border-b border-[#17231b] bg-[#0c0e0c] px-2 py-1 font-mono text-[#cdd2cd]">
              {file.newPath || file.oldPath}
            </div>
            <Diff diffType={file.type} hunks={file.hunks} viewType="unified">
              {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
            </Diff>
          </div>
        ))}
      </div>
    </>
  );
}
