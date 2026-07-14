// runner.ts — the run lifecycle. Accepts a run start, drives a real Agent SDK
// query() in the session worktree, normalizes every SDK message into Contract-1
// envelopes (normalizer.ts) and ships them via the transport. Follow-ups push
// into a live pushable input iterable (no respawn); interrupt() stops the run.
// Tracks the single active run. NEVER finalizes run state — Rails does that from
// the lifecycle events this runner emits.

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { EventEnvelope } from "@clawdparty/contracts";
import { Normalizer } from "./normalizer.js";
import type { Transport } from "./transport.js";

export interface StartRunInput {
  run_id: string;
  session_id: string;
  repo_path: string;
  prompt: string;
  requested_by: string;
  model?: string;
  max_turns?: number;
  permission_mode?: string;
  allowed_tools?: string[];
  claude_session_id?: string;
}

// The SDK Query surface the runner needs: an async-iterable of messages + interrupt.
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt: () => Promise<void>;
}
export type QueryFn = (params: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => QueryHandle;

// A pushable async iterable: the streaming-input channel follow-ups push into.
class PushableInput implements AsyncIterable<unknown> {
  private readonly queue: unknown[] = [];
  private resolve: ((r: IteratorResult<unknown>) => void) | null = null;
  private closed = false;

  push(message: unknown): void {
    if (this.closed) {
      return;
    }
    if (this.resolve) {
      this.resolve({ value: message, done: false });
      this.resolve = null;
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    this.closed = true;
    if (this.resolve) {
      this.resolve({ value: undefined, done: true });
      this.resolve = null;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

interface ActiveRun {
  runId: string;
  handle: QueryHandle;
  input: PushableInput;
  normalizer: Normalizer;
  requestedBy: string;
}

export class RunConflict extends Error {}
export class UnknownRun extends Error {}

export class Runner {
  private active: ActiveRun | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly queryFn: QueryFn = sdkQuery as unknown as QueryFn,
  ) {}

  activeRunIds(): string[] {
    return this.active ? [this.active.runId] : [];
  }

  // Accept a run start. One active run at a time — a second start throws RunConflict
  // (the index.ts handler maps it to 409). Drives the query in the background and
  // ships normalized events; returns once the query is launched (async to client).
  startRun(input: StartRunInput): void {
    if (this.active) {
      throw new RunConflict("a run is already active");
    }
    const normalizer = new Normalizer({
      sessionId: input.session_id,
      aiRunId: input.run_id,
      requestedBy: input.requested_by,
    });
    const pushable = new PushableInput();
    pushable.push(userMessage(input.prompt));

    const handle = this.queryFn({
      prompt: pushable,
      options: buildOptions(input),
    });

    this.active = {
      runId: input.run_id,
      handle,
      input: pushable,
      normalizer,
      requestedBy: input.requested_by,
    };
    void this.drain(this.active);
  }

  // Push a follow-up into the live run's input iterable (no respawn).
  sendMessage(runId: string, message: string): void {
    const run = this.requireActive(runId);
    run.input.push(userMessage(message));
  }

  // Interrupt the active run and emit run_interrupted (user-attributed).
  async interrupt(runId: string): Promise<void> {
    const run = this.requireActive(runId);
    await run.handle.interrupt();
    await this.ship([run.normalizer.runInterrupted()]);
    // Rails finalizes the run state; the runner only emits the event + clears active.
  }

  private requireActive(runId: string): ActiveRun {
    if (!this.active || this.active.runId !== runId) {
      throw new UnknownRun(`run ${runId} is not active`);
    }
    return this.active;
  }

  // Consume the SDK message stream, normalize each, and ship the envelopes.
  private async drain(run: ActiveRun): Promise<void> {
    try {
      for await (const message of run.handle) {
        await this.ship(run.normalizer.normalize(message));
      }
    } catch (err) {
      this.transport.logger.error({ err: String(err) }, "run drain error");
    } finally {
      run.input.close();
      if (this.active?.runId === run.runId) {
        this.active = null;
      }
    }
  }

  // Durable events ride the batched/retried path; ephemeral go fire-and-forget.
  private async ship(events: EventEnvelope[]): Promise<void> {
    const durable = events.filter((e) => !isEphemeral(e.type));
    const ephemeral = events.filter((e) => isEphemeral(e.type));
    if (durable.length > 0) {
      await this.transport.deliverDurable(durable);
    }
    for (const e of ephemeral) {
      await this.transport.deliverEphemeral(e);
    }
  }
}

function isEphemeral(type: string): boolean {
  return type === "ai_text_delta" || type === "presence_changed";
}

function userMessage(text: string): unknown {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

function buildOptions(input: StartRunInput): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: input.repo_path,
    permissionMode: input.permission_mode ?? "acceptEdits",
    allowedTools: input.allowed_tools ?? ["Read", "Write", "Edit", "Bash"],
  };
  if (input.model) {
    options.model = input.model;
  }
  if (input.max_turns) {
    options.maxTurns = input.max_turns;
  }
  if (input.claude_session_id) {
    options.resume = input.claude_session_id;
  }
  return options;
}
