import { memo, useEffect, useState } from "react";
import { formatDurationLong } from "@/lib/utils";

/** Whole seconds, then minutes — "0s", "8s", "1m 5s". Never a decimal: a
 * fraction of a second is noise next to an agent's pace. */
export function formatElapsed(ms: number): string {
  return formatDurationLong(Math.max(0, Math.floor(ms / 1000)));
}

/** "0:12", "1:05", "1:02:09" — the stop button's clock, where a running
 * counter reads better as a clock than as words. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}` : `${String(minutes)}:${seconds}`;
}

interface ElapsedProps {
  startedAt: number;
  /** Fixed once known; while absent the value ticks on its own. */
  endedAt?: number;
  /** Render as a clock ("0:12") instead of words ("12s"). */
  clock?: boolean;
  className?: string;
}

/**
 * A live elapsed time, and the only thing in the log that ticks. It owns its
 * interval so the clock re-renders itself and nothing above it — the log's
 * rows are memoized precisely so that streaming doesn't re-render them, and a
 * timer held by a parent would undo that every second.
 */
export const Elapsed = memo(function Elapsed({ startedAt, endedAt, clock, className }: ElapsedProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== undefined) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endedAt]);
  const ms = (endedAt ?? now) - startedAt;
  return <span className={className}>{clock ? formatClock(ms) : formatElapsed(ms)}</span>;
});
