import type { FC } from "react";

// The clawdparty glyph: two overlapping "party" circles, the trailing one dimmed.
// Sized by the width/height of its 20×12 inner box so nav (30px chip) and footer
// (bare) can reuse it. Presentation only.
export const LogoMark: FC<{ className?: string }> = ({ className }) => (
  <div className={`relative ${className ?? ""}`} style={{ width: 20, height: 12 }}>
    <span
      className="absolute left-0 top-0 rounded-full"
      style={{ width: 12, height: 12, border: "1.5px solid #4fe89a" }}
    />
    <span
      className="absolute right-0 top-0 rounded-full"
      style={{ width: 12, height: 12, border: "1.5px solid rgba(79,232,154,.45)" }}
    />
  </div>
);

// Full wordmark: chip-framed glyph + "clawd·party" text. Used in the nav bar.
export const LogoWordmark: FC = () => (
  <div className="flex items-center gap-[11px]">
    <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border border-[#262c28] bg-[#161a18]">
      <LogoMark />
    </div>
    <span className="text-[16px] font-semibold tracking-[-0.2px]">
      clawd<span className="text-[#4fe89a]">party</span>
    </span>
  </div>
);
