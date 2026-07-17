import type { FC } from "react";

interface Feature {
  icon: string;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: "◎",
    title: "One live session",
    body: "Everyone joins the same room and watches Claude work in real time — no screen-shares, no copy-pasting transcripts between private chats.",
  },
  {
    icon: "⌘",
    title: "Guide as a group",
    body: "Anyone with a seat can steer: send follow-ups, interrupt a run, or drop context. The whole team shapes the work together.",
  },
  {
    icon: "⎇",
    title: "Review every change",
    body: "Claude's edits land as a reviewable diff. Approve to commit, reject to revert — nothing touches the repo until the room agrees.",
  },
];

// "Why clawdparty" — a centered eyebrow/heading over a 3-up feature grid.
export const LandingFeatures: FC = () => (
  <section id="features" className="mx-auto max-w-[1080px] px-8 pb-6 pt-16">
    <div className="mb-12 text-center">
      <span className="font-mono text-xs uppercase tracking-[2px] text-[#4fe89a]">
        {"// why clawdparty"}
      </span>
      <h2 className="mt-[14px] text-[38px] font-bold tracking-[-1px]">
        One room. One brain. Everyone in it.
      </h2>
    </div>
    <div className="grid grid-cols-1 gap-[18px] md:grid-cols-3">
      {FEATURES.map((f) => (
        <div
          key={f.title}
          className="rounded-[16px] border border-[#1d221f] bg-[#0f1211] px-6 py-[26px]"
        >
          <div className="mb-[18px] flex h-11 w-11 items-center justify-center rounded-[12px] border border-[#2a352d] bg-[#141a16] text-[19px] text-[#4fe89a]">
            {f.icon}
          </div>
          <h3 className="mb-2 text-[19px] font-semibold">{f.title}</h3>
          <p className="text-[14.5px] leading-[1.6] text-[#a4aca6]" style={{ textWrap: "pretty" }}>
            {f.body}
          </p>
        </div>
      ))}
    </div>
  </section>
);
