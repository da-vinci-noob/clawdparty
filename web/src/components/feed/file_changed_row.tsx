import type { EventEnvelope, FileChangedPayload } from "@clawdparty/contracts";
import type { FC } from "react";

// A compact per-file change row. The full diff is NOT inline — it is reviewed via
// the diff API / the W3 review screen.
export const FileChangedRow: FC<{ event: EventEnvelope }> = ({ event }) => {
  const { path, change } = event.payload as FileChangedPayload;
  return (
    <div data-testid="feed-file-changed" className="flex gap-2 text-xs text-emerald-400">
      <span className="text-neutral-500">{change === "created" ? "+" : "~"}</span>
      <span className="truncate">{path}</span>
    </div>
  );
};
