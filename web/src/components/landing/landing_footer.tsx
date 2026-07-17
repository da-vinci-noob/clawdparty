import type { FC } from "react";
import { LogoMark } from "./logo_mark";

export const LandingFooter: FC = () => (
  <footer className="flex flex-wrap items-center justify-between gap-[14px] border-t border-[#171d19] px-8 py-7">
    <div className="flex items-center gap-[10px]">
      <LogoMark className="scale-90" />
      <span className="text-[13px] text-[#79817b]">clawdparty — shared ai sessions</span>
    </div>
    <span className="font-mono text-xs text-[#3a4038]">built at the hackathon · 2026</span>
  </footer>
);
