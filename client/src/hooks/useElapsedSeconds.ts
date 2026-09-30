import { useEffect, useState } from "react";

/** Seconds since `since`, ticking once a second — same live-timer shape as
 * `BackgroundJobIndicator`'s local `ElapsedTime`, factored out so the
 * background-activity tray and its inline cards can share it instead of
 * each growing their own copy. */
export function useElapsedSeconds(since: number): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.floor((Date.now() - since) / 1000));

  useEffect(() => {
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - since) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [since]);

  return elapsedSeconds;
}
