import type { NeutralMessage, ProviderRequest, ToolSchema } from "../providers/contract.js";
import type { ToolResult } from "../tools/registry.js";

/**
 * The four named extension points. Registered code observes, transforms, or refuses
 * work at a documented place in the loop.
 *
 * `tool:before` is THE command-gating point — the role the dead
 * `permissions.ts` seam was supposed to fill and never could, because nothing
 * imported it. A point that cannot intercept must not exist ,
 * so wiring this is what makes deleting that file a fix rather than a loss.
 *
 * This gate ships BEFORE the harness moves to the host. On the host a
 * model-directed `bash` runs with the developer's full privileges, so an interval
 * in which nothing can refuse it is not acceptable.
 */

export type Outcome<T> =
  /** Pass through, possibly transformed. */
  | { k: "continue"; value: T }
  /** Deny. Visible in the shared feed as `tool_refused`. */
  | { k: "refuse"; reason: string }
  /** Short-circuit with a substitute; remaining handlers are skipped. */
  | { k: "replace"; value: T };

export interface RequestCtx {
  model: string;
  system: string;
  messages: NeutralMessage[];
  tools: ToolSchema[];
  request?: ProviderRequest;
}

export interface ToolCallCtx {
  toolUseId: string;
  name: string;
  input: unknown;
  cwd: string;
  runId: string;
}

export interface ToolResultCtx {
  toolUseId: string;
  name: string;
  result: ToolResult;
}

export interface RunOutcomeCtx {
  runId: string;
  outcome: "finished" | "failed" | "interrupted";
  uncertain: boolean;
  turns: number;
}

export interface PointTypes {
  "request:before": RequestCtx;
  "tool:before": ToolCallCtx;
  "tool:after": ToolResultCtx;
  "run:complete": RunOutcomeCtx;
}

export type PointName = keyof PointTypes;

/**
 * Priority BANDS, ascending. Bundled code runs first, third-party last.
 *
 * Documented and deterministic — never load order. Load order is
 * an accident of the filesystem, so a conflict resolved by it is a conflict
 * resolved differently on someone else's machine.
 */
export const PRIORITY = {
  bundled: 0,
  firstPartyPlugin: 50,
  thirdPartyPlugin: 100,
} as const;

/**
 * `tool:before` gets 30s because it may await a human approval; everything else
 * gets 5s.
 */
export const TIMEOUT_MS: Record<PointName, number> = {
  "request:before": 5_000,
  "tool:before": 30_000,
  "tool:after": 5_000,
  "run:complete": 5_000,
};

/**
 * What happens when a handler times out or throws.
 *
 * `tool:before` FAILS CLOSED, and this is the one asymmetry worth stating
 * outright: a hung approval gate must not silently permit the command it was
 * installed to gate. Everywhere else a failure is contained as `continue`, because
 * a broken transform should not take down the run.
 */
export const ON_FAILURE: Record<PointName, "continue" | "refuse"> = {
  "request:before": "continue",
  "tool:before": "refuse",
  "tool:after": "continue",
  "run:complete": "continue",
};

/** Failures in one session before a contributor is auto-disabled. */
export const STRIKE_LIMIT = 3;

export interface Handler<P extends PointName> {
  /** The contributor's identity — named in every log line and refusal. */
  id: string;
  point: P;
  priority: number;
  run: (ctx: PointTypes[P]) => Promise<Outcome<PointTypes[P]>> | Outcome<PointTypes[P]>;
}

export interface DispatchLog {
  warn: (message: string, detail?: Record<string, unknown>) => void;
}

export interface DispatchResult<T> {
  outcome: Outcome<T>;
  /** Set when a handler refused or replaced, so the caller can attribute it. */
  by?: string;
  /** Handlers that timed out or threw during this dispatch. */
  failed: string[];
}

export class ExtensionRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: handlers are heterogeneous by point
  private readonly handlers = new Map<PointName, Array<Handler<any>>>();
  private readonly strikes = new Map<string, number>();
  private readonly disabled = new Set<string>();
  private readonly log: DispatchLog;

  constructor(log: DispatchLog = { warn: () => {} }) {
    this.log = log;
  }

  register<P extends PointName>(handler: Handler<P>): this {
    const list = this.handlers.get(handler.point) ?? [];
    list.push(handler);
    // Stable sort by band; registration order is preserved WITHIN a band, which is
    // the documented tie-break.
    list.sort((a, b) => a.priority - b.priority);
    this.handlers.set(handler.point, list);
    return this;
  }

  /**
   * Removal is TOTAL: the next run behaves as if the contributor never existed
   *. Strikes are cleared too, so a re-enabled plugin is not
   * disabled by a previous session's history.
   */
  unregister(id: string): void {
    for (const [point, list] of this.handlers) {
      this.handlers.set(
        point,
        list.filter((h) => h.id !== id),
      );
    }
    this.strikes.delete(id);
    this.disabled.delete(id);
  }

  handlersFor(point: PointName): string[] {
    return (this.handlers.get(point) ?? [])
      .filter((h) => !this.disabled.has(h.id))
      .map((h) => h.id);
  }

  isDisabled(id: string): boolean {
    return this.disabled.has(id);
  }

  /**
   * Run every handler for a point in resolution order.
   *
   * Refusal wins and short-circuits — a later handler cannot un-refuse. `replace`
   * short-circuits too. `continue` passes the TRANSFORMED value onward, so
   * transforms compose.
   */
  async dispatch<P extends PointName>(
    point: P,
    ctx: PointTypes[P],
  ): Promise<DispatchResult<PointTypes[P]>> {
    const failed: string[] = [];
    let current = ctx;

    for (const handler of this.handlers.get(point) ?? []) {
      if (this.disabled.has(handler.id)) continue;

      let outcome: Outcome<PointTypes[P]>;
      try {
        outcome = await this.withTimeout(point, handler, current);
      } catch (err) {
        failed.push(handler.id);
        this.strike(handler.id, point, err);
        if (ON_FAILURE[point] === "refuse") {
          return {
            outcome: {
              k: "refuse",
              // Names the handler, so a fail-closed refusal is attributable
              // rather than looking like the model was blocked for no reason.
              reason: `${handler.id} failed on ${point} and this point fails closed: ${String(err)}`,
            },
            by: handler.id,
            failed,
          };
        }
        continue;
      }

      if (outcome.k === "refuse") return { outcome, by: handler.id, failed };
      if (outcome.k === "replace") return { outcome, by: handler.id, failed };
      current = outcome.value;
    }

    return { outcome: { k: "continue", value: current }, failed };
  }

  /**
   * Abandon a handler that exceeds its bound. The promise is not cancellable — a
   * handler can keep running — but the loop stops waiting on it, which is what the
   * time bound is for.
   */
  private async withTimeout<P extends PointName>(
    point: P,
    handler: Handler<P>,
    ctx: PointTypes[P],
  ): Promise<Outcome<PointTypes[P]>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(handler.run(ctx)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${TIMEOUT_MS[point]}ms`)),
            TIMEOUT_MS[point],
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private strike(id: string, point: PointName, err: unknown): void {
    const count = (this.strikes.get(id) ?? 0) + 1;
    this.strikes.set(id, count);
    this.log.warn(`extension handler failed on ${point}`, {
      handler: id,
      strikes: count,
      error: String(err),
    });

    if (count >= STRIKE_LIMIT) {
      this.disabled.add(id);
      this.log.warn(`extension auto-disabled for this session after ${STRIKE_LIMIT} failures`, {
        handler: id,
      });
    }
  }
}
