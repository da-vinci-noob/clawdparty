import type { FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Dark-theme markdown renderer for Claude's settled `ai_text` blocks. react-markdown
// does NOT render raw HTML by default (no rehype-raw), so authored markdown becomes
// safe DOM — `**bold**`/backticks/`##`/lists render as real elements, not literal text.
// GFM (remark-gfm) adds tables, strikethrough, and task lists. Styling is Tailwind
// arbitrary-variant selectors on the wrapper so no per-node component overrides are
// needed. Keeps `data-testid="feed-text"` so the existing feed tests still resolve it.
export const Markdown: FC<{ children: string }> = ({ children }) => (
  <div
    data-testid="feed-text"
    className="space-y-2 text-sm leading-relaxed text-neutral-100 [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-700 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 [&_code]:rounded [&_code]:bg-neutral-800 [&_code]:px-1 [&_code]:text-[0.85em] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-neutral-900 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_strong]:font-semibold [&_table]:w-full [&_td]:border-b [&_td]:border-neutral-800 [&_th]:border-b [&_th]:border-neutral-700 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5"
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);
