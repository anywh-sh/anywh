// Claude Code's `rate_limit_event` (stream-json, one per turn: after the
// `assistant` message, before `result`) → plan windows. Recorded with
// Claude Code 2.1.303 (journal/99 §1.2):
//
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//    "resetsAt":1793333400,"rateLimitType":"five_hour",...,
//    "unifiedWindows":{"five_hour":{"utilization":0.63,"resetsAt":1793333400},
//                      "seven_day":{"utilization":0.19,"resetsAt":1793746800}}}}
//
// `utilization` is a 0–1 fraction and `resetsAt` epoch seconds. The top-level
// fields describe only the "representative" window; the bars come from
// `unifiedWindows`, which is undocumented — so every field is read
// defensively and a malformed window is dropped, never guessed.
//
// Pure: no I/O, no clock.
import { PLAN_WINDOW_MINS, type PlanUsageStatus, type PlanWindow } from "./types.js";
import { clampPercent, epochSecondsToMs, isRecord, sortWindows } from "./windows.js";

/** `rate_limit_info.status` values the binary is known to emit;
 * `allowed_warning` exists in the binary but was never observed. */
export type ClaudeRateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface ClaudeRateLimitReading {
  /** null when the event carried a status this parser doesn't know. */
  claudeStatus: ClaudeRateLimitStatus | null;
  /** Ascending by duration. */
  windows: PlanWindow[];
  /** `allowed_warning`'s threshold (0–1 fraction in the binary, ×100 here). */
  surpassedThresholdPercent?: number;
}

const NAMED_WINDOW_MINS: Readonly<Record<string, number>> = {
  five_hour: PLAN_WINDOW_MINS.fiveHour,
  seven_day: PLAN_WINDOW_MINS.sevenDay,
};

/** Duration of a `unifiedWindows` key: `five_hour`, `seven_day`, and the
 * model-scoped `seven_day_<scope>` (`seven_day_opus`). Unknown keys → null:
 * a window whose length isn't known can't be drawn honestly. */
function durationOfWindowKey(key: string): { durationMins: number; limitId?: string } | null {
  const named = NAMED_WINDOW_MINS[key];
  if (named !== undefined) return { durationMins: named };
  if (key.startsWith("seven_day_")) return { durationMins: PLAN_WINDOW_MINS.sevenDay, limitId: key };
  if (key.startsWith("five_hour_")) return { durationMins: PLAN_WINDOW_MINS.fiveHour, limitId: key };
  return null;
}

function parseWindow(key: string, raw: unknown): PlanWindow | null {
  const duration = durationOfWindowKey(key);
  if (!duration || !isRecord(raw)) return null;
  const fraction = raw.utilization;
  if (typeof fraction !== "number") return null;
  const usedPercent = clampPercent(fraction * 100);
  if (usedPercent === null) return null;
  return { ...duration, usedPercent, resetsAt: epochSecondsToMs(raw.resetsAt) };
}

function parseStatus(value: unknown): ClaudeRateLimitStatus | null {
  return value === "allowed" || value === "allowed_warning" || value === "rejected" ? value : null;
}

/**
 * Parses one stream-json event. Returns null for anything that isn't a
 * `rate_limit_event` with a `rate_limit_info` object. A recognized event with
 * no readable window still returns (with `windows: []`), so a `rejected`
 * status isn't lost to a missing field.
 */
export function parseClaudeRateLimitEvent(event: unknown): ClaudeRateLimitReading | null {
  if (!isRecord(event) || event.type !== "rate_limit_event") return null;
  const info = event.rate_limit_info;
  if (!isRecord(info)) return null;

  const windows: PlanWindow[] = [];
  if (isRecord(info.unifiedWindows)) {
    for (const [key, raw] of Object.entries(info.unifiedWindows)) {
      const window = parseWindow(key, raw);
      if (window) windows.push(window);
    }
  } else if (typeof info.rateLimitType === "string") {
    // Older shape without `unifiedWindows`: the top-level fields describe
    // the one representative window, when they carry a utilization at all.
    const window = parseWindow(info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt });
    if (window) windows.push(window);
  }

  const reading: ClaudeRateLimitReading = { claudeStatus: parseStatus(info.status), windows: sortWindows(windows) };
  if (typeof info.surpassedThreshold === "number") {
    const threshold = clampPercent(info.surpassedThreshold * 100);
    if (threshold !== null) reading.surpassedThresholdPercent = threshold;
  }
  return reading;
}

/** The plan status a reading implies. `rejected`, or any window at 100 %,
 * is `limited`; `allowed_warning` is `warning`; an unknown status falls back
 * to what the windows say. */
export function claudeReadingStatus(reading: ClaudeRateLimitReading): PlanUsageStatus {
  if (reading.claudeStatus === "rejected") return "limited";
  if (reading.windows.some((window) => window.usedPercent >= 100)) return "limited";
  if (reading.claudeStatus === "allowed_warning") return "warning";
  return "ok";
}
