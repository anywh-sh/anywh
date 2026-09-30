import { memo, useEffect, useState } from "react";
import { formatDurationLong } from "@/lib/utils";

/** Whole seconds, then minutes — "0s", "8s", "1m 5s". Never a decimal: a
 * fraction of a second is noise next to an agent's pace. */
export function formatElapsed(ms: number): string {
  return formatDurationLong(Math.max(0, Math.floor(ms / 1000)));
}

interface ElapsedProps {
  startedAt: number;
  /** Fixed once known; while absent the value ticks on its own. */
  endedAt?: number;
  className?: string;
}

/**
 * A live elapsed time, and the only thing in the log that ticks. It owns its
 * interval so the clock re-renders itself and nothing above it — the log's
 * rows are memoized precisely so that streaming doesn't re-render them, and a
 * timer held by a parent would undo that every second.
 */
export const Elapsed = memo(function Elapsed({ startedAt, endedAt, className }: ElapsedProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== undefined) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endedAt]);
  const ms = (endedAt ?? now) - startedAt;
  return <span className={className}>{formatElapsed(ms)}</span>;
});
