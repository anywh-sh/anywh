import type { SessionListCache } from "@/lib/format/sessionListCache";
import type { SessionSummary } from "@/lib/relay/relay-types";

/** A session plus the profile it belongs to — what a list merged across
 * profiles has to carry on every row, since the profile is no longer
 * implied by which list you are looking at. */
export interface MergedSession extends SessionSummary {
  profileId: string;
}

/** The recency buckets the sidebar renders, in display order. Kept as ids
 * rather than labels so the copy lives in the dictionary. */
export const SESSION_GROUP_IDS = ["today", "yesterday", "week", "older"] as const;

export type SessionGroupId = (typeof SESSION_GROUP_IDS)[number];

export interface SessionGroup {
  id: SessionGroupId;
  sessions: MergedSession[];
}

/**
 * Every selected profile's cached rows in one list, newest first.
 *
 * `profileIds` is the filter, already resolved to the profiles that actually
 * exist — a cached entry for a profile that was removed from the device is
 * skipped rather than rendered as a row nothing can open. Each side arrives
 * already sorted by the relay, but the merge has to re-sort: the relay's
 * ordering only holds within one profile's own list.
 */
export function mergeProfileSessions(cache: SessionListCache, profileIds: ReadonlySet<string>): MergedSession[] {
  const merged: MergedSession[] = [];
  for (const [profileId, entry] of Object.entries(cache)) {
    if (!profileIds.has(profileId)) continue;
    for (const session of entry.sessions) merged.push({ ...session, profileId });
  }
  // A row with no timestamp sorts to the bottom instead of poisoning the
  // comparison with `NaN` (which would leave the whole list in an arbitrary
  // order). Ties keep insertion order — `sort` is stable — so an outdated
  // relay's list still reads in the order that relay sent it.
  return merged.sort((a, b) => (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity));
}

/** Midnight of the day `epochMs` falls on, in the device's own timezone —
 * the boundary that makes "yesterday" mean the previous calendar day rather
 * than "24 hours ago". A conversation at 23:50 and one at 00:10 belong to
 * different days even though ten minutes separate them, which is how a
 * person reads their own history. */
function startOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Partitions an already-merged, already-sorted list into the recency
 * buckets, preserving order within each one.
 *
 * "older" is not decoration: without a final catch-all every conversation
 * past a week would simply vanish from the sidebar. An empty bucket is
 * dropped, so the list never shows a heading with nothing under it.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so the day
 * boundaries are testable without freezing the clock globally.
 */
export function groupSessionsByRecency(sessions: readonly MergedSession[], now: number = Date.now()): SessionGroup[] {
  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  // Sessions are bucketed by the calendar day they fall on, so the week
  // bucket ends at the start of the day 7 days back — not at `now - 7d`,
  // which would split a single day across two headings.
  const weekAgo = today - 6 * DAY_MS;

  const buckets: Record<SessionGroupId, MergedSession[]> = { today: [], yesterday: [], week: [], older: [] };

  for (const session of sessions) {
    // No timestamp at all (a relay too old to send one) goes to "older":
    // the one bucket that claims nothing about when the session was used.
    if (session.lastActiveAt === null) buckets.older.push(session);
    // A timestamp in the future (a relay whose clock runs ahead, a device
    // whose clock runs behind) still belongs at the top of the list, which
    // is "today" — not in a bucket of its own and not dropped.
    else if (session.lastActiveAt >= today) buckets.today.push(session);
    else if (session.lastActiveAt >= yesterday) buckets.yesterday.push(session);
    else if (session.lastActiveAt >= weekAgo) buckets.week.push(session);
    else buckets.older.push(session);
  }

  return SESSION_GROUP_IDS.filter((id) => buckets[id].length > 0).map((id) => ({ id, sessions: buckets[id] }));
}
