import type { FC, ReactNode } from "react";

interface Props {
  children?: ReactNode;
  // Region slots filled by the session page. Default to nothing so a bare render
  // (the shell smoke test) still shows all three labelled regions.
  sidebar?: ReactNode;
  chat?: ReactNode;
  // The center pane's terminal-style titlebar (path + avatars + live count) and
  // the composer that sits pinned at the bottom of the center column.
  titlebar?: ReactNode;
  composer?: ReactNode;
}

// The session workspace (docs/PLAN.md §6), styled to the dark-green design:
// a fixed 264px left sidebar / fluid center "terminal" (titlebar · scrollable
// feed · composer) / fixed 340px right chat sidebar. Regions are filled via slots
// by the session page. aria-labels are load-bearing (the shell test asserts them).
export const AppShell: FC<Props> = ({ children, sidebar, chat, titlebar, composer }) => (
  <div
    className="grid h-screen w-screen overflow-hidden bg-[#0d0f0e] text-[#e6ebe4]"
    style={{ gridTemplateColumns: "264px 1fr 340px" }}
  >
    <aside
      aria-label="Sessions sidebar"
      className="flex min-h-0 min-w-0 flex-col border-r border-[#1d221f] bg-[#0f1211]"
    >
      {sidebar}
    </aside>

    <main
      aria-label="Activity tabs"
      className="relative flex min-h-0 min-w-0 flex-col bg-[#0b0e0c]"
    >
      {/* faint radial glow behind the terminal, matching the reference */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% -10%, rgba(79,232,154,.035), transparent 60%)",
        }}
      />
      {titlebar}
      <section className="relative z-[1] min-h-0 flex-1 overflow-auto px-6 pb-2 pt-5">
        {children}
      </section>
      {composer}
    </main>

    <aside
      aria-label="Chat sidebar"
      className="flex min-h-0 min-w-0 flex-col border-l border-[#1d221f] bg-[#0f1211]"
    >
      {chat}
    </aside>
  </div>
);
