import { memo, useEffect, useState } from "react";
import { formatDurationLong } from "@/lib/utils";

/** "2.4s" under ten seconds, then whole seconds/minutes — the precision a
 * short tool call needs and a long one doesn't. */
export function formatElapsed(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped < 10_000 ? `${(clamped / 1000).toFixed(1)}s` : formatDurationLong(Math.floor(clamped / 1000));
}

interface ElapsedProps {
  startedAt: number;
  /** Fixed once known; while absent the value ticks on its own. */
  endedAt?: number;
  className?: string;
  /** Whole seconds ("8s") instead of tenths ("8.2s") — for a clock that
   * sits still in a button rather than beside a call. */
  whole?: boolean;
}

/**
 * A live elapsed time, and the only thing in the log that ticks. It owns its
 * interval so the clock re-renders itself and nothing above it — the log's
 * rows are memoized precisely so that streaming doesn't re-render them, and a
 * timer held by a parent would undo that every second.
 */
export const Elapsed = memo(function Elapsed({ startedAt, endedAt, className, whole }: ElapsedProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== undefined) return;
    const interval = setInterval(() => setNow(Date.now()), whole ? 1000 : 250);
    return () => clearInterval(interval);
  }, [endedAt, whole]);
  const ms = (endedAt ?? now) - startedAt;
  return <span className={className}>{whole ? formatDurationLong(Math.max(0, Math.floor(ms / 1000))) : formatElapsed(ms)}</span>;
});
