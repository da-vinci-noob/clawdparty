import type { EventEnvelope } from "@clawdparty/contracts";
import { type FC, useEffect, useRef } from "react";
import type { ParticipantNames } from "../helpers/participant_names";
import { selectActiveRunId, selectDurableEvents, useEventStore } from "../stores/event_store";
import { FileChangedRow } from "./feed/file_changed_row";
import { RawFallback } from "./feed/raw_fallback";
import { RunBanner } from "./feed/run_banner";
import { ShimmerLoader } from "./feed/shimmer_loader";
import { TerminalBlock } from "./feed/terminal_block";
import { TextBlock } from "./feed/text_block";
import { ThinkingBlock } from "./feed/thinking_block";
import { ToolChip } from "./feed/tool_chip";
import { UserPromptBlock } from "./feed/user_prompt_block";
import { useParticipantList } from "./participant_list";

// Cap the rendered durable set so a long run doesn't render thousands of nodes.
const FEED_CAP = 500;

// Within this many px of the bottom counts as "pinned to the bottom".
const STICK_THRESHOLD_PX = 80;

// The feed's nearest scrollable ancestor (the AppShell center <section>), found
// by walking up — so auto-scroll doesn't hard-code the DOM nesting.
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

const RUN_LIFECYCLE = new Set([
  "run_started",
  "run_finished",
  "run_failed",
  "run_interrupted",
  "changeset_ready",
  "changeset_approved",
  "changeset_rejected",
]);

interface Props {
  names?: ParticipantNames;
}

// The center-pane activity feed: renders the cable-client store's durable log
// richly (per the frozen taxonomy) plus the trailing in-progress streamed text.
// Read-only; no shell input path. Unknown/ai_raw types degrade to a safe fallback.
// Resolves actor ids → display names from participant_joined events (same source
// as the chat panel), so run banners + user prompts show names, not "#<id>". The
// `names` prop overrides that (tests inject a fixed map).
export const ActivityFeed: FC<Props> = ({ names }) => {
  const listNames = useParticipantList();
  const resolvedNames = names ?? listNames;
  const durable = useEventStore(selectDurableEvents);
  const textByBlock = useEventStore((s) => s.textByBlock);
  const thinkingByBlock = useEventStore((s) => s.thinkingByBlock);
  const activeRunId = useEventStore(selectActiveRunId);

  const feedRef = useRef<HTMLDivElement>(null);
  // Whether the user is pinned to the bottom. Starts true (open at newest); flips
  // to false when they scroll up to read history, so new content doesn't yank them.
  const stick = useRef(true);

  // Track the pinned-to-bottom state from the scroll container.
  useEffect(() => {
    const scroller = getScrollParent(feedRef.current);
    if (!scroller) {
      return;
    }
    const onScroll = (): void => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      stick.current = distanceFromBottom < STICK_THRESHOLD_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to the newest content as the feed grows — new events AND streaming
  // text/thinking — but only while pinned to the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on rendered-content growth
  useEffect(() => {
    if (!stick.current) {
      return;
    }
    const scroller = getScrollParent(feedRef.current);
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [durable, textByBlock, thinkingByBlock]);

  // Pair each tool_started with its tool_finished/tool_failed (same tool_use_id).
  const finishByToolId = new Map<string, EventEnvelope>();
  for (const e of durable) {
    if (e.type === "tool_finished" || e.type === "tool_failed") {
      const id = (e.payload as { tool_use_id?: string }).tool_use_id;
      if (id) finishByToolId.set(id, e);
    }
  }

  const windowed = durable.slice(-FEED_CAP);

  return (
    <div
      ref={feedRef}
      data-testid="activity-feed"
      className="space-y-4 font-mono text-[13px] leading-[1.65]"
    >
      {windowed.map((event) => (
        <div key={event.id ?? `${event.type}-${event.ts}`}>
          {renderEvent(event, finishByToolId, resolvedNames)}
        </div>
      ))}
      {[...thinkingByBlock.entries()].map(([block, text]) => (
        <div key={`think-${block}`}>
          <ThinkingBlock text={text} streaming />
        </div>
      ))}
      {[...textByBlock.entries()].map(([block, text]) => (
        <div
          key={`live-${block}`}
          data-testid="feed-streaming-text"
          className="pl-[26px] text-[13px] text-[#cdd2cd]"
        >
          {text}
          <span
            className="ml-[1px] inline-block h-[14px] w-[8px] translate-y-[2px] bg-[#3b9dff]"
            style={{
              animation: "cp-blink 1.1s step-end infinite",
              boxShadow: "0 0 8px rgba(59,157,255,.5)",
            }}
          />
        </div>
      ))}
      {/* While a run is active with no streaming text yet, show the shimmer loader. */}
      {activeRunId && textByBlock.size === 0 && <ShimmerLoader />}
    </div>
  );
};

function renderEvent(
  event: EventEnvelope,
  finishByToolId: Map<string, EventEnvelope>,
  names: ParticipantNames,
) {
  switch (event.type) {
    case "user_prompt":
      return <UserPromptBlock event={event} names={names} />;
    case "ai_text":
      return <TextBlock event={event} />;
    case "ai_thinking":
      return <ThinkingBlock text={(event.payload as { text?: string }).text ?? ""} />;
    case "tool_started": {
      const id = (event.payload as { tool_use_id?: string }).tool_use_id;
      return <ToolChip startEvent={event} finishEvent={id ? finishByToolId.get(id) : undefined} />;
    }
    case "tool_finished":
    case "tool_failed":
      // Rendered as part of their tool_started chip; skip standalone.
      return null;
    case "terminal_output":
      return <TerminalBlock event={event} />;
    case "file_changed":
      return <FileChangedRow event={event} />;
    case "participant_joined":
      // A social banner ("<name> joined the session"), same framing as the run
      // lifecycle — the name is resolved from actor.id via the names map.
      return <RunBanner event={event} names={names} />;
    case "ai_raw":
      // The normalizer's safety valve for unmapped SDK messages. Still persisted
      // (contract: never dropped) and available via backfill, but not user-facing
      // noise — nothing to render in the feed.
      return null;
    default:
      if (RUN_LIFECYCLE.has(event.type)) {
        return <RunBanner event={event} names={names} />;
      }
      // Any other unmapped type → safe collapsible fallback (never crashes).
      return <RawFallback event={event} />;
  }
}
