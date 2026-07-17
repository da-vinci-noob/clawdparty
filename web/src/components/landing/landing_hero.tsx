import type { FC } from "react";

// A stack of colored monogram avatars, reused by the hero terminal header and the
// approval card. Each avatar overlaps the previous by 6–7px.
const Avatar: FC<{ initials: string; bg: string; color: string; overlap?: boolean }> = ({
  initials,
  bg,
  color,
  overlap,
}) => (
  <div
    className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-[#0d110f] font-mono text-[9px] font-semibold"
    style={{ background: bg, color, marginLeft: overlap ? -6 : 0 }}
  >
    {initials}
  </div>
);

// Hero: eyebrow pill + headline + subcopy + CTAs, over a radial-glow + grid
// backdrop, followed by the floating "clawd@party" terminal mockup.
export const LandingHero: FC<{ onStart: () => void }> = ({ onStart }) => (
  <header className="relative overflow-hidden px-8 pb-[88px] pt-24">
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background: "radial-gradient(90% 60% at 50% -5%, rgba(79,232,154,.09), transparent 55%)",
      }}
    />
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          "linear-gradient(#141a1650 1px,transparent 1px),linear-gradient(90deg,#141a1650 1px,transparent 1px)",
        backgroundSize: "52px 52px",
        maskImage: "radial-gradient(70% 55% at 50% 20%,#000,transparent 80%)",
        WebkitMaskImage: "radial-gradient(70% 55% at 50% 20%,#000,transparent 80%)",
      }}
    />

    <div className="relative mx-auto max-w-[900px] text-center">
      <div className="mb-7 inline-flex items-center gap-[9px] rounded-[30px] border border-[#232a25] bg-[#111511] px-[14px] py-[6px] font-mono text-xs text-[#8fb8a2]">
        <span
          className="h-[7px] w-[7px] rounded-full bg-[#4fe89a]"
          style={{ boxShadow: "0 0 8px rgba(79,232,154,.85)" }}
        />
        shared ai sessions · live &amp; collaborative
      </div>
      <h1
        className="mb-[22px] text-[66px] font-bold leading-[1.04] tracking-[-1.8px]"
        style={{ textWrap: "balance" }}
      >
        Think together.
        <br />
        <span
          className="relative text-[#4fe89a]"
          style={{ textShadow: "rgba(79,232,154,.35) 0 0 40px" }}
        >
          Decide together.
        </span>
      </h1>
      <p
        className="mx-auto mb-[38px] max-w-[600px] text-[19px] leading-[1.6] text-[#a4aca6]"
        style={{ textWrap: "pretty" }}
      >
        clawdparty puts your whole team inside one live AI session — where ideas get proposed,
        refined, and approved as a group, not siloed in a dozen private chats.
      </p>
      <div className="flex flex-wrap justify-center gap-[13px]">
        <button
          type="button"
          onClick={onStart}
          className="flex items-center gap-2 rounded-[11px] bg-[#4fe89a] px-[26px] py-[14px] text-[15px] font-semibold text-[#0e1a13] shadow-[0_0_24px_rgba(79,232,154,.3)] transition hover:brightness-110"
        >
          Create or join a session <span className="font-mono">→</span>
        </button>
        <a
          href="#features"
          className="flex items-center gap-2 rounded-[11px] border border-[#2a322c] bg-transparent px-[26px] py-[14px] text-[15px] font-semibold text-[#d4dbd2] hover:text-[#d4dbd2]"
        >
          See how it works
        </a>
      </div>
    </div>

    {/* floating terminal mockup */}
    <div
      className="relative mx-auto mt-16 max-w-[880px]"
      style={{ animation: "cp-float 6s ease-in-out infinite" }}
    >
      <div
        className="overflow-hidden rounded-[16px] border border-[#1d251f] bg-[#0b0e0c]"
        style={{ boxShadow: "0 40px 120px rgba(0,0,0,.6), 0 0 0 1px rgba(79,232,154,.04)" }}
      >
        <div className="flex items-center gap-[10px] border-b border-[#171d19] bg-[#0d110f] px-4 py-[13px]">
          <div className="flex gap-[7px]">
            <span className="h-[11px] w-[11px] rounded-full bg-[#242a26]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#242a26]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#242a26]" />
          </div>
          <span className="ml-1 font-mono text-xs text-[#565d58]">
            clawd@party<span className="text-[#3a4038]">:</span>
            <span className="text-[#4fe89a]" style={{ textShadow: "0 0 12px rgba(79,232,154,.4)" }}>
              ~/redesign-onboarding
            </span>
          </span>
          <div className="flex-1" />
          <div className="flex items-center">
            <Avatar initials="MK" bg="#414d47" color="#d7ded9" />
            <Avatar initials="DP" bg="#4d473f" color="#ded7cd" overlap />
            <Avatar initials="JL" bg="#3f4a4d" color="#cdd8da" overlap />
          </div>
        </div>
        <div className="px-6 py-[22px] text-left font-mono text-[13.5px] leading-[1.7]">
          <div className="mb-[14px] text-[11px] text-[#565d58]">
            — maya, devon &amp; jin joined · model claude-sonnet-4.6 —
          </div>
          <div className="mb-[14px] flex gap-[10px]">
            <span className="text-[#4fe89a]" style={{ textShadow: "0 0 10px rgba(79,232,154,.5)" }}>
              ❯
            </span>
            <span className="text-[#d4dbd2]">
              Find the 3 biggest drop-off risks in onboarding. Pull the funnel first.
            </span>
          </div>
          <div className="mb-4 pl-5 text-[#c2c8c3]">
            Three cliffs stand out — email verify <span className="text-[#e6ebe4]">-38%</span>,
            workspace setup <span className="text-[#e6ebe4]">-24%</span>, empty state{" "}
            <span className="text-[#e6ebe4]">-19%</span>. Draft fixes?
          </div>
          <div className="flex items-center gap-[11px] pb-1 pt-[2px]">
            <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[6px] border border-[#2a352d] bg-[#141a16]">
              <span
                className="h-[6px] w-[6px] rounded-full bg-[#4fe89a]"
                style={{ animation: "cp-pulse 1.4s ease-in-out infinite" }}
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
              Razzmatazzing
            </span>
            <span
              className="h-4 w-[9px] bg-[#4fe89a]"
              style={{
                animation: "cp-blink 1.1s step-end infinite",
                boxShadow: "0 0 8px rgba(79,232,154,.5)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  </header>
);
