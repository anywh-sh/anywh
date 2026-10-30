// The seam between the agent streams and the plan usage service: the
// session drivers hand it what a real turn already says about the plan
// (Claude's `rate_limit_event`, Codex's `account/rateLimits/updated` push)
// and tell it when a turn starts and ends, so the scheduler can skip a probe
// while one is running (journal/99 §5.2, D3). Nothing here is an
// `AgentEvent`: the readings never enter a session's log or replay.
//
// One instance per relay process (= per profile), `planUsageCapture`; the
// drivers take another one only in tests. Listeners are called
// synchronously and their errors are swallowed — a broken listener must
// never break a turn.
import { claudeReadingStatus, parseClaudeRateLimitEvent } from "./claudeEvent.js";
import { parseCodexRateLimitsUpdated, type CodexLimitBucket } from "./codexLimits.js";
import type { PlanUsageReading } from "./ingest.js";
import type { PlanUsageRuntime } from "./types.js";

/** Codex's push notification of new limits; it carries no `threadId`. */
export const CODEX_RATE_LIMITS_UPDATED_METHOD = "account/rateLimits/updated";

export type PlanUsageCaptureEvent =
  /** A Claude turn's `rate_limit_event`, already parsed: feed to
   * `ingestReading`. */
  | { kind: "reading"; runtime: "claude"; reading: PlanUsageReading }
  /** A Codex push, parsed but not merged: the service folds it into its
   * `CodexRateLimits` with `mergeCodexRateLimits` (a push is sparse, and a
   * bucket alone says nothing about `ordinaryUsageAllowed`). */
  | {
      kind: "codex_push";
      runtime: "codex";
      bucket: CodexLimitBucket;
      observedAt: number;
    }
  /** The runtime went from no turn running to one (`active: true`), or back
   * (`active: false`). Counted across every session of the relay. */
  | { kind: "turn_activity"; runtime: PlanUsageRuntime; active: boolean };

export type PlanUsageCaptureListener = (event: PlanUsageCaptureEvent) => void;

/** The runtime a def id names, when it has a plan to read. */
export function planUsageRuntimeOf(defId: string): PlanUsageRuntime | undefined {
  return defId === "claude" || defId === "codex" ? defId : undefined;
}

export class PlanUsageCapture {
  private readonly listeners = new Set<PlanUsageCaptureListener>();
  private readonly activeTurns: Record<PlanUsageRuntime, number> = {
    claude: 0,
    codex: 0,
  };

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: PlanUsageCaptureListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Any raw Claude stream-json event; returns whether it was a
   * `rate_limit_event` that produced a reading. */
  claudeEvent(event: unknown): boolean {
    const parsed = parseClaudeRateLimitEvent(event);
    if (!parsed) return false;
    const status = claudeReadingStatus(parsed);
    if (status !== "ok" && status !== "warning" && status !== "limited") return false;
    this.emit({
      kind: "reading",
      runtime: "claude",
      reading: {
        status,
        windows: parsed.windows,
        observedAt: this.now(),
        source: "turn",
      },
    });
    return true;
  }

  /** A Codex app-server notification; returns whether it was an
   * `account/rateLimits/updated` (whatever its content), so the caller can
   * keep it away from the chat mapper. */
  codexNotification(method: string, params: unknown): boolean {
    if (method !== CODEX_RATE_LIMITS_UPDATED_METHOD) return false;
    const bucket = parseCodexRateLimitsUpdated(params);
    if (bucket)
      this.emit({
        kind: "codex_push",
        runtime: "codex",
        bucket,
        observedAt: this.now(),
      });
    return true;
  }

  /** Marks a turn of `runtime` as running. Returns its end, safe to call
   * more than once. */
  turnStarted(runtime: PlanUsageRuntime): () => void {
    this.activeTurns[runtime] += 1;
    if (this.activeTurns[runtime] === 1) this.emit({ kind: "turn_activity", runtime, active: true });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeTurns[runtime] -= 1;
      if (this.activeTurns[runtime] === 0) this.emit({ kind: "turn_activity", runtime, active: false });
    };
  }

  isTurnActive(runtime: PlanUsageRuntime): boolean {
    return this.activeTurns[runtime] > 0;
  }

  private emit(event: PlanUsageCaptureEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // See the file comment: a listener never breaks a turn.
      }
    }
  }
}

/** The relay's one capture, shared by every session driver. */
export const planUsageCapture = new PlanUsageCapture();
