// When a bot's schedule fires: five-field cron, in the host's time zone,
// read by `croner` (it handles day-of-week names, steps and daylight-saving
// shifts, which a hand-written parser would get wrong).
//
// Pure apart from the time zone, which is the host's (or the one given).
import { Cron } from "croner";

export type CronCheck = { ok: true } | { ok: false; error: string };

function cronOf(expression: string, timezone?: string): Cron {
  return new Cron(expression, { paused: true, mode: "5-part", ...(timezone ? { timezone } : {}) });
}

export function checkCron(expression: string): CronCheck {
  try {
    const next = cronOf(expression).nextRun();
    if (!next) return { ok: false, error: "That cron never fires." };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Invalid cron "${expression}": ${(error as Error).message}. Use five fields: minute hour day-of-month month day-of-week.` };
  }
}

/** The first time `expression` fires strictly after `afterMs`, or
 * `undefined` when it never does (or does not parse). */
export function nextRunAfter(expression: string, afterMs: number, timezone?: string): number | undefined {
  try {
    const next = cronOf(expression, timezone).nextRun(new Date(afterMs));
    return next ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/** How late a run may start and still count (the relay was down, or the
 * machine asleep, at the time): later than this it is recorded as missed. */
export const MISSED_RUN_GRACE_MS = 60 * 60 * 1000;

/** What to do with a schedule armed for `dueAt` when the relay looks at it
 * `now`: run it, record it as missed, or wait. */
export function dueDecision(dueAt: number, now: number, graceMs = MISSED_RUN_GRACE_MS): "run" | "missed" | "wait" {
  if (dueAt > now) return "wait";
  return now - dueAt <= graceMs ? "run" : "missed";
}
