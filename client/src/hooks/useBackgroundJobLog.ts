import { useEffect, useState } from "react";
import { getBackgroundJobLog } from "@/lib/relay/backgroundJobClient";
import type { Profile } from "@/lib/profiles/profiles";

const POLL_INTERVAL_MS = 2000;

/** `loading` until the first read answers; `unavailable` when reads fail
 * and nothing was ever read — a relay predating the log route, or one that
 * can't be reached. */
export type BackgroundJobLogStatus = "loading" | "ok" | "unavailable";

export interface BackgroundJobLog {
  tail: string | null;
  status: BackgroundJobLogStatus;
}

/**
 * A running `anywh-bg` job's log tail, re-read every couple of seconds — but
 * only while `enabled`, which callers tie to "a card showing this job is on
 * screen right now" (the tray is open, the tab is the focused one). Each read
 * is a file tail on the relay host; doing that for a job nobody is looking at
 * is the kind of background cost the status bar's own comment rules out.
 *
 * A failed read keeps the last good tail rather than blanking it, so a job
 * that just finished doesn't flash empty before its row goes away — it only
 * turns `unavailable` when there was never a tail to keep.
 */
export function useBackgroundJobLog(profile: Profile | undefined, sessionId: string, jobId: string, enabled: boolean): BackgroundJobLog {
  const [tail, setTail] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const profileId = profile?.id;

  useEffect(() => {
    if (!profile || !enabled) return;
    let cancelled = false;
    const read = () => {
      getBackgroundJobLog(profile, sessionId, jobId)
        .then((next) => {
          if (cancelled) return;
          setTail((prev) => (prev === next ? prev : next));
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
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

  return { tail, status: tail !== null ? "ok" : failed ? "unavailable" : "loading" };
}
