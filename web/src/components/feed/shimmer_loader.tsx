import { type FC, useEffect, useState } from "react";

// The "clawd is working" indicator shown while a run is active but not yet
// streaming text: a floating dot, a shimmering verb, bouncing dots, and the
// "esc to interrupt" hint. The verb rotates purely for flavor (matches the
// reference's playful loader words).
const WORDS = ["Razzmatazzing", "Percolating", "Noodling", "Conjuring", "Finagling", "Marinating"];

export const ShimmerLoader: FC = () => {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % WORDS.length), 2600);
    return () => clearInterval(t);
  }, []);

  return (
    <div data-testid="feed-shimmer" className="flex items-center gap-[11px] pb-1 pt-[6px]">
      <div
        className="flex h-5 w-5 items-center justify-center rounded-[6px] border border-[#2a352d] bg-[#141a16]"
        style={{ animation: "cp-float 2.6s ease-in-out infinite" }}
      >
        <span
          className="h-[7px] w-[7px] rounded-full bg-[#4fe89a]"
          style={{ animation: "cp-pulse 1.5s ease-in-out infinite" }}
        />
      </div>
      <span
        className="text-[13px] font-medium"
        style={{
          background: "linear-gradient(90deg,#4a524b 20%,#4fe89a 50%,#4a524b 80%)",
          backgroundSize: "200% 100%",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          WebkitTextFillColor: "transparent",
          animation: "cp-shimmer 2s linear infinite",
        }}
      >
        {WORDS[i]}
      </span>
      <span className="ml-[2px] flex gap-[3px]">
        <span
          className="h-1 w-1 rounded-full bg-[#4fe89a]"
          style={{ animation: "cp-pulse 1s ease-in-out infinite" }}
        />
        <span
          className="h-1 w-1 rounded-full bg-[#4fe89a]"
          style={{ animation: "cp-pulse 1s ease-in-out .2s infinite" }}
        />
        <span
          className="h-1 w-1 rounded-full bg-[#4fe89a]"
          style={{ animation: "cp-pulse 1s ease-in-out .4s infinite" }}
        />
      </span>
      <span className="ml-[6px] font-mono text-[11px] text-[#3a4038]">esc to interrupt</span>
    </div>
  );
};
