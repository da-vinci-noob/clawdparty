import type { EventEnvelope } from "@clawdparty/contracts";
import { type FC, useEffect, useRef } from "react";
import type { ParticipantNames } from "../helpers/participant_names";
import {
  laneByRun,
  selectActiveRunId,
  selectDurableEvents,
  useEventStore,
} from "../stores/event_store";
import { ContextCompactedRow } from "./feed/context_compacted_row";
import { FileChangedRow } from "./feed/file_changed_row";
import { ProviderErrorRow } from "./feed/provider_error_row";
import { RawFallback } from "./feed/raw_fallback";
import { RecoveryAppliedRow } from "./feed/recovery_applied_row";
import { RunBanner } from "./feed/run_banner";
import { ShimmerLoader } from "./feed/shimmer_loader";
import { StreamingText } from "./feed/streaming_text";
import { TerminalBlock } from "./feed/terminal_block";
import { TextBlock } from "./feed/text_block";
import { ThinkingBlock } from "./feed/thinking_block";
import { ToolChip } from "./feed/tool_chip";
import { ToolRefusedRow } from "./feed/tool_refused_row";
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
  const runPending = useEventStore((s) => s.runPending);

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
  // Which lane each run is in, for the row labels. Computed from the STABLE durable array
  // rather than subscribed to as a selector: it builds a new Map, and Zustand compares by reference,
  // so subscribing looped the render.
  const lanes = laneByRun(durable);

  return (
    <div
      ref={feedRef}
      data-testid="activity-feed"
      className="space-y-4 font-mono text-[13px] leading-[1.65]"
    >
      {windowed.map((event) => (
        <div key={event.id ?? `${event.type}-${event.ts}`} className="relative">
          {renderEvent(event, finishByToolId, resolvedNames)}
          {/* ONE ordered stream, with each row labelled by lane — not a split feed. The
              shared room is the product's central claim, and interleaving is information: you can
              see two streams racing. Only a NON-DEFAULT lane is labelled, so a single-lane session
              (which is every session until someone opens a second) carries no noise at all. */}
          {laneLabel(event, lanes)}
        </div>
      ))}
      {[...thinkingByBlock.entries()].map(([block, text]) => (
        <div key={`think-${block}`}>
          <ThinkingBlock text={text} streaming />
        </div>
      ))}
      {[...textByBlock.entries()].map(([block, text]) => (
        <div key={`live-${block}`} className="space-y-2">
          <StreamingText text={text} />
        </div>
      ))}
      {/* Claude is working whenever a run is live OR one has been submitted and has not spoken
          yet. Gating on "no streamed text" alone left two blind windows: before `run_started`
          arrives there is no active run to derive, and a non-streaming turn never streams text
          at all, so the room looked frozen for the whole turn. */}
      {(activeRunId !== null || runPending) && <ShimmerLoader />}
    </div>
  );
};

/**
 * The lane chip for a row, or nothing.
 *
 * Absent for the default lane and for events that belong to no run (a chat message, a participant
 * joining): labelling those would attribute a session-level occurrence to a work stream.
 */
function laneLabel(event: EventEnvelope, laneByRun: Map<string, string>) {
  const lane = event.ai_run_id === null ? undefined : laneByRun.get(event.ai_run_id);
  if (lane === undefined) {
    return null;
  }
  return (
    <span
      data-testid="feed-lane"
      className="absolute right-0 top-0 rounded-[5px] bg-[#0f1c2b] px-[6px] py-px font-mono text-[10px] uppercase tracking-[1px] text-[#3b9dff]"
    >
      {lane}
    </span>
  );
}

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
    case "recovery_applied":
      // Its OWN row, and NOT the RUN_LIFECYCLE banner below. A generic banner would say
      // "run failed" or "run finished" about a request whose fate is genuinely unknown
      //.
      return <RecoveryAppliedRow event={event} />;
    case "tool_refused":
      // Its OWN row, not folded into the chip: a refusal is the room's policy
      // acting, not a tool breaking, and showing them alike would hide the rule.
      return <ToolRefusedRow event={event} />;
    case "provider_error":
      // Not a RUN_LIFECYCLE banner: the credential failed, the session did not, and a
      // "run failed" framing would send the room off to create a new one.
      return <ProviderErrorRow event={event} />;
    case "context_compacted":
      // The one occurrence that changes what Claude can still remember. With no row, a session
      // silently loses its early turns and the only clue is Claude later behaving as if it had
      // never read them.
      return <ContextCompactedRow event={event} />;
    case "terminal_output":
      return <TerminalBlock event={event} />;
    case "file_changed":
      return <FileChangedRow event={event} />;
    case "participant_removed":
      // A social banner like joining, and in the same stream: the room learns who lost access the
      // same way it learned who gained it. Their earlier messages stay above it, still attributed.
      return <RunBanner event={event} names={names} />;
    case "participant_joined":
      // A social banner ("<name> joined the session"), same framing as the run
      // lifecycle — the name is resolved from actor.id via the names map.
      return <RunBanner event={event} names={names} />;
    case "plugin_enabled":
    case "plugin_disabled":
      // A capability change, in the timeline. Which rules are in force decides what Claude may do,
      // so the room learns of a change the same way it learns everything else.
      return <RunBanner event={event} names={names} />;
    case "skill_changed":
      // Not a run event, but it belongs in the timeline: a skill is instructions Claude will
      // follow, so who changed what the room can do is part of its history. Recording it and
      // rendering nothing would leave an audit trail nobody reads.
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
