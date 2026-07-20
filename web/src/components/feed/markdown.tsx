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
    className="max-w-[680px] space-y-2 pl-[26px] text-[13px] leading-relaxed text-[#cdd2cd] [&_a]:text-[#3b9dff] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[#1c2a20] [&_blockquote]:pl-2 [&_blockquote]:text-[#7c847c] [&_code]:rounded [&_code]:bg-[#0e140f] [&_code]:px-1 [&_code]:text-[0.85em] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-[#0a0a0a] [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_strong]:font-semibold [&_strong]:text-[#e6e8e6] [&_table]:w-full [&_td]:border-b [&_td]:border-[#16211a] [&_th]:border-b [&_th]:border-[#1c2a20] [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5"
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);
