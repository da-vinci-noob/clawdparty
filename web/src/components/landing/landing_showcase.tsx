import type { FC } from "react";

const POINTS = [
  "Every proposed action is shown to the whole room before it runs.",
  "Approvals and rejections happen in the open — no silent commits.",
  "Reject reverts the worktree cleanly; approve commits it for everyone.",
];

// Monogram avatar used in the approval card (24px, slightly larger than the hero).
const CardAvatar: FC<{ initials: string; bg: string; color: string; overlap?: boolean }> = ({
  initials,
  bg,
  color,
  overlap,
}) => (
  <div
    className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#0d110f] font-mono text-[9px] font-semibold"
    style={{ background: bg, color, marginLeft: overlap ? -7 : 0 }}
  >
    {initials}
  </div>
);

// "Decide together" — a two-column showcase: copy + checklist on the left, an
// "CLAWD WANTS TO RUN" approval card mockup on the right.
export const LandingShowcase: FC = () => (
  <section id="decide" className="mx-auto max-w-[1080px] px-8 py-[72px]">
    <div className="grid grid-cols-1 items-center gap-14 md:grid-cols-2">
      <div>
        <span className="font-mono text-xs uppercase tracking-[2px] text-[#4fe89a]">
          {"// decide together"}
        </span>
        <h2 className="mb-[18px] mt-[14px] text-[36px] font-bold leading-[1.1] tracking-[-1px]">
          Nothing ships until the room says go.
        </h2>
        <p
          className="mb-[26px] text-[16px] leading-[1.65] text-[#a4aca6]"
          style={{ textWrap: "pretty" }}
        >
          When clawd wants to run a command, deploy a preview, or touch a connector, it asks the
          whole room first. Everyone sees the proposed action, weighs in, and votes — approvals and
          rejections happen in the open.
        </p>
        <div className="flex flex-col gap-[14px]">
          {POINTS.map((p) => (
            <div key={p} className="flex items-start gap-3">
              <span className="mt-px flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[7px] border border-[#2a352d] bg-[#17241b] text-xs text-[#4fe89a]">
                ✓
              </span>
              <span className="text-[15px] leading-[1.5] text-[#d4dbd2]">{p}</span>
            </div>
          ))}
        </div>
      </div>

      {/* approval card mockup */}
      <div
        className="overflow-hidden rounded-[16px] border border-[#262f28] bg-[#0d110f]"
        style={{ boxShadow: "0 30px 80px rgba(0,0,0,.5)" }}
      >
        <div className="flex items-center gap-2 border-b border-[#1b221d] bg-[#0f1311] px-4 py-[13px]">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[7px] bg-[#17241b] text-xs text-[#4fe89a]">
            ⚡
          </span>
          <span className="font-mono text-[11px] tracking-[0.4px] text-[#79817b]">
            CLAWD WANTS TO RUN
          </span>
        </div>
        <div className="px-4 py-[18px]">
          <div className="mb-[5px] font-mono text-[14px] text-[#e6ebe4]">
            deploy → staging-preview
          </div>
          <div className="mb-[18px] text-[13px] leading-[1.55] text-[#79817b]">
            Push the magic-link onboarding branch to a shareable preview URL. Needs the room's OK.
          </div>
          <div className="mb-4 flex items-center gap-[9px]">
            <div className="flex">
              <CardAvatar initials="DP" bg="#4d473f" color="#ded7cd" />
              <CardAvatar initials="JL" bg="#3f4a4d" color="#cdd8da" overlap />
            </div>
            <span className="text-xs text-[#79817b]">2 approved · waiting on maya</span>
          </div>
          <div className="flex gap-[9px]">
            <div className="flex-1 rounded-[9px] bg-[#4fe89a] p-[11px] text-center font-mono text-xs font-semibold text-[#0e1a13] shadow-[0_0_14px_rgba(79,232,154,.28)]">
              ✓ Approve
            </div>
            <div className="flex-1 rounded-[9px] border border-[#332723] bg-transparent p-[11px] text-center font-mono text-xs font-semibold text-[#b58a7d]">
              ✕ Reject
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
);
