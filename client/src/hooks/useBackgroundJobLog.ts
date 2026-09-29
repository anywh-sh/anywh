import { useEffect, useState } from "react";
import { getBackgroundJobLog } from "@/lib/relay/backgroundJobClient";
import type { Profile } from "@/lib/profiles/profiles";

const POLL_INTERVAL_MS = 2000;

/**
 * A running `anywh-bg` job's log tail, re-read every couple of seconds — but
 * only while `enabled`, which callers tie to "a card showing this job is on
 * screen right now" (the tray is open, the tab is the focused one). Each read
 * is a file tail on the relay host; doing that for a job nobody is looking at
 * is the kind of background cost the status bar's own comment rules out.
 *
 * `null` until the first read lands; a failed read keeps the last good tail
 * rather than blanking it, so a job that just finished doesn't flash empty
 * before its row goes away.
 */
export function useBackgroundJobLog(profile: Profile | undefined, sessionId: string, jobId: string, enabled: boolean): string | null {
  const [tail, setTail] = useState<string | null>(null);
  const profileId = profile?.id;

  useEffect(() => {
    if (!profile || !enabled) return;
    let cancelled = false;
    const read = () => {
      getBackgroundJobLog(profile, sessionId, jobId)
        .then((next) => {
          if (!cancelled) setTail((prev) => (prev === next ? prev : next));
        })
        .catch(() => {});
    };
    read();
    const interval = setInterval(read, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // `profile` is a fresh object on most renders; its id decides the machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, sessionId, jobId, enabled]);

  return tail;
}
