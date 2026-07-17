import type { FC } from "react";
import { LogoWordmark } from "./logo_mark";

// Sticky translucent nav. The "Start a session" button scrolls to the #cp-start
// module (the Join/Create form) rather than routing anywhere.
export const LandingNav: FC<{ onStart: () => void }> = ({ onStart }) => (
  <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-[#171d19] bg-[#0d0f0e]/75 px-8 py-4 backdrop-blur-md">
    <LogoWordmark />
    <div className="flex items-center gap-[26px]">
      <a href="#features" className="text-sm font-medium text-[#a4aca6] hover:text-[#7ff2b8]">
        Features
      </a>
      <a href="#decide" className="text-sm font-medium text-[#a4aca6] hover:text-[#7ff2b8]">
        How it works
      </a>
      <button
        type="button"
        onClick={onStart}
        className="rounded-[9px] bg-[#4fe89a] px-[18px] py-[9px] text-sm font-semibold text-[#0e1a13] shadow-[0_0_16px_rgba(79,232,154,.28)] transition hover:brightness-110"
      >
        Start a session
      </button>
    </div>
  </nav>
);
