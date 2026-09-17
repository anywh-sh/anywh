import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, ToolInput } from "../protocol/agent-event.js";

// `ScheduleWakeup` is a native Claude Code CLI tool (not an MCP server this
// relay registers) that assumes the `claude` process that called it stays
// alive to host the timer internally and re-inject `prompt` on its own once
// `delaySeconds` elapses. The relay spawns `claude -p [--resume <id>]` PER
// TURN (runtimes/defs/claude/session.ts) and that process exits the moment
// the turn ends — so on this relay the timer has nowhere to run, and the
// call silently does nothing. `WakeupScheduler` is what gives it somewhere:
// it watches every turn's events for a `ScheduleWakeup` call that the
// harness reported as successful, arms an ordinary timer on the relay's own
// (long-lived) process instead, and turns its firing into a brand new turn
// via `SessionManager.handleWakeupFired` — same "async event outlives the
// turn's own `claude -p` process" shape `BackgroundJobTracker` already
// solves for `anywh-bg` jobs, reused here for a completely different trigger.

const SCHEDULE_WAKEUP_TOOL_NAME = "ScheduleWakeup";

/** What a `ScheduleWakeup` call's `tool_started`/`tool_ended` pair resolved
 * to, once the harness's own outcome (`tool_ended.isError`) and the call's
 * `input` are both known. */
export type ScheduleWakeupOutcome =
  | { kind: "discard" }
  | { kind: "cancel" }
  | { kind: "arm"; delaySeconds: number; prompt: string };

/**
 * Pure decision logic — no timers, no `fs`, no `Date.now()` — isolated from
 * `WakeupScheduler.observeEvent` so it can be tested against loose `input`
 * shapes without assembling a real `tool_started`/`tool_ended` pair.
 *
 * `isError: true` (e.g. the harness's own "`prompt` is required when `stop`
 * is not true" rejection) always discards: nothing should have been armed
 * for a call the harness itself refused. Otherwise `stop: true` cancels
 * regardless of anything else in `input` (mirrors the tool's own semantics —
 * cancelling doesn't also need a valid `delaySeconds`/`prompt`). Anything
 * that doesn't parse into a usable `delaySeconds` (finite, > 0) and `prompt`
 * (non-empty string) is discarded rather than armed — guards against a
 * future schema drift in the harness's own tool turning into a `setTimeout`
 * with garbage input.
 */
export function decideScheduleWakeupOutcome(input: ToolInput, isError: boolean): ScheduleWakeupOutcome {
  if (isError) return { kind: "discard" };
  if (input.stop === true) return { kind: "cancel" };
  const { delaySeconds, prompt } = input;
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds) || delaySeconds <= 0) return { kind: "discard" };
  if (typeof prompt !== "string" || prompt.trim() === "") return { kind: "discard" };
  return { kind: "arm", delaySeconds, prompt };
}

interface PendingCall {
  sessionId: string;
  input: ToolInput;
}

interface ArmedWakeup {
  sessionId: string;
  fireAt: number;
  prompt: string;
}

export interface WakeupSchedulerOptions {
  /** Called when an armed wakeup's timer fires — this is how
   * `SessionManager` turns it into a new turn (`handleWakeupFired`). */
  onFire: (sessionId: string, prompt: string) => void;
  /** Same persistence pattern as `BackgroundJobTracker`: the whole state is
   * written on every mutation and reloaded in the constructor, so an armed
   * wakeup survives a relay restart. `undefined` (tests' default) keeps the
   * previous in-memory-only behavior. */
  persistPath?: string;
}

export class WakeupScheduler {
  /** Correlates a `ScheduleWakeup` `tool_started` with its own `tool_ended`
   * — nothing is armed until the matching `tool_ended` confirms the harness
   * accepted the call. An entry whose turn ends without a matching
   * `tool_ended` (stream cut mid-call) is simply never armed — no explicit
   * "turn ended" hook is needed for that, since a stray `tool_ended` for the
   * same `toolUseId` never arrives afterward (the CLI never reuses one). */
  private readonly pendingCalls = new Map<string, PendingCall>();
  /** At most one armed wakeup per session, keyed by `sessionId` — same
   * semantics as the tool itself (each tick of a `/loop` reagenda o
   * fallback, replacing the previous one). */
  private readonly armed = new Map<string, ArmedWakeup>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: WakeupSchedulerOptions) {
    if (this.options.persistPath) {
      for (const wakeup of this.load(this.options.persistPath)) {
        this.armed.set(wakeup.sessionId, wakeup);
        this.scheduleTimer(wakeup);
      }
    }
  }

  /** Never throws — a missing file (first time) or a corrupted one just
   * starts empty, same pattern as `BackgroundJobTracker.load`. */
  private load(persistPath: string): ArmedWakeup[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(persistPath, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ArmedWakeup =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ArmedWakeup).sessionId === "string" &&
        typeof (entry as ArmedWakeup).fireAt === "number" &&
        typeof (entry as ArmedWakeup).prompt === "string",
    );
  }

  /** Writes the whole state on every mutation — same debounce-free pattern
   * as `BackgroundJobTracker.persist`/`SessionStore`: armings are rare
   * (never on a timer tick), so the cost of one more `writeFileSync` doesn't
   * matter. No-op if `persistPath` wasn't configured. */
  private persist(): void {
    if (!this.options.persistPath) return;
    mkdirSync(dirname(this.options.persistPath), { recursive: true });
    writeFileSync(this.options.persistPath, JSON.stringify([...this.armed.values()], null, 2));
  }

  /** Called with every `AgentEvent` of every turn (see `SessionManager`'s
   * `onEvent`) — a no-op for almost all of them, only reacts to a
   * `ScheduleWakeup` tool call. */
  observeEvent(sessionId: string, event: AgentEvent): void {
    if (event.type === "tool_started" && event.name === SCHEDULE_WAKEUP_TOOL_NAME && event.toolUseId) {
      this.pendingCalls.set(event.toolUseId, { sessionId, input: event.input });
      return;
    }
    if (event.type !== "tool_ended" || !event.toolUseId) return;
    const pending = this.pendingCalls.get(event.toolUseId);
    if (!pending) return;
    this.pendingCalls.delete(event.toolUseId);

    const outcome = decideScheduleWakeupOutcome(pending.input, event.isError);
    if (outcome.kind === "discard") return;
    if (outcome.kind === "cancel") {
      this.cancelForSession(pending.sessionId);
      return;
    }
    this.armWakeup(pending.sessionId, outcome.delaySeconds, outcome.prompt);
  }

  private armWakeup(sessionId: string, delaySeconds: number, prompt: string): void {
    this.clearTimer(sessionId);
    const wakeup: ArmedWakeup = { sessionId, fireAt: Date.now() + delaySeconds * 1000, prompt };
    this.armed.set(sessionId, wakeup);
    this.persist();
    this.scheduleTimer(wakeup);
  }

  /** `delay` clamped to 0 (never negative) covers both a fresh arming and a
   * wakeup reloaded from disk whose `fireAt` already passed while the relay
   * was down — fires once, right away, instead of getting lost. */
  private scheduleTimer(wakeup: ArmedWakeup): void {
    const delay = Math.max(0, wakeup.fireAt - Date.now());
    const timer = setTimeout(() => this.fire(wakeup.sessionId), delay);
    timer.unref?.();
    this.timers.set(wakeup.sessionId, timer);
  }

  private fire(sessionId: string): void {
    const wakeup = this.armed.get(sessionId);
    if (!wakeup) return; // cancelled or replaced since the timer was scheduled
    this.armed.delete(sessionId);
    this.timers.delete(sessionId);
    this.persist();
    this.options.onFire(sessionId, wakeup.prompt);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /** Cancellation from three places: an explicit `stop: true` call, a real
   * user message (or `/clear`) arriving before the timer fires, or the
   * session being deleted. Returns `false` with no effect if nothing was
   * armed — same no-throw contract as `BackgroundJobTracker.cancel`. Also
   * drops any `tool_started` still awaiting its `tool_ended` for this
   * session, so a late `tool_ended` can't resurrect a wakeup after the
   * session has moved on. */
  cancelForSession(sessionId: string): boolean {
    const had = this.armed.delete(sessionId);
    this.clearTimer(sessionId);
    if (had) this.persist();
    for (const [toolUseId, pending] of this.pendingCalls) {
      if (pending.sessionId === sessionId) this.pendingCalls.delete(toolUseId);
    }
    return had;
  }

  /** Only for tests — production never needs to inspect this directly. */
  listArmed(): ArmedWakeup[] {
    return [...this.armed.values()];
  }
}
