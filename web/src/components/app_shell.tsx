import type { FC, ReactNode } from "react";

interface Props {
  children?: ReactNode;
}

// The static workspace layout from docs/PLAN.md §6: left sidebar / center tabs /
// right chat sidebar. Placeholder STRUCTURE ONLY — renders no data, reads no
// event store, opens no cable connection. W2 fills these regions.
export const AppShell: FC<Props> = ({ children }) => (
  <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
    <aside aria-label="Sessions sidebar" className="w-64 shrink-0 border-r border-neutral-800 p-3">
      <h1 className="text-sm font-semibold text-neutral-400">clawdparty</h1>
    </aside>

    <main aria-label="Activity tabs" className="flex min-w-0 flex-1 flex-col">
      <nav aria-label="Center tabs" className="flex gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="text-sm text-neutral-400">Activity</span>
      </nav>
      <section className="min-h-0 flex-1 overflow-auto p-3">{children}</section>
    </main>

    <aside aria-label="Chat sidebar" className="w-80 shrink-0 border-l border-neutral-800 p-3">
      <h2 className="text-sm font-semibold text-neutral-400">Chat</h2>
    </aside>
  </div>
);
