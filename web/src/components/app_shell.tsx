import type { FC, ReactNode } from "react";

interface Props {
  children?: ReactNode;
  // Optional region slots; default to the static placeholders so a bare render
  // (e.g. the W1 shell smoke test) still shows all three regions.
  sidebar?: ReactNode;
  chat?: ReactNode;
  footer?: ReactNode;
}

// The workspace layout from docs/PLAN.md §6: left sidebar / center (tabs + feed +
// composer) / right chat sidebar. Regions are filled via slots by the session page.
export const AppShell: FC<Props> = ({ children, sidebar, chat, footer }) => (
  <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
    <aside aria-label="Sessions sidebar" className="w-64 shrink-0 border-r border-neutral-800 p-3">
      <h1 className="mb-3 text-sm font-semibold text-neutral-400">clawdparty</h1>
      {sidebar}
    </aside>

    <main aria-label="Activity tabs" className="flex min-w-0 flex-1 flex-col">
      <nav aria-label="Center tabs" className="flex gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="text-sm text-neutral-400">Activity</span>
      </nav>
      <section className="min-h-0 flex-1 overflow-auto p-3">{children}</section>
      {footer}
    </main>

    <aside
      aria-label="Chat sidebar"
      className="flex w-80 shrink-0 flex-col border-l border-neutral-800 p-3"
    >
      <h2 className="mb-2 text-sm font-semibold text-neutral-400">Chat</h2>
      {chat ?? <div className="text-xs text-neutral-600">No chat</div>}
    </aside>
  </div>
);
