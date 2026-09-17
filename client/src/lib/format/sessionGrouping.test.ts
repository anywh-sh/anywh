import { describe, expect, it } from "vitest";
import { groupSessionsByRecency, mergeProfileSessions, type MergedSession } from "@/lib/format/sessionGrouping";
import type { SessionListCache } from "@/lib/format/sessionListCache";

/** A fixed wall-clock moment, mid-afternoon, so "start of today" is hours
 * away from both the current time and midnight — a boundary test anchored at
 * 00:00 would pass for the wrong reason. */
const NOW = new Date("2026-03-15T15:30:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function at(iso: string): number {
  return new Date(iso).getTime();
}

function session(id: string, lastActiveAt: number | null, profileId = "p1"): MergedSession {
  return { id, title: id, lastActiveAt, profileId };
}

describe("mergeProfileSessions, with an undated list", () => {
  // `NaN` from a missing timestamp doesn't just misplace that one row: it
  // makes the comparator inconsistent and leaves the whole list in an
  // arbitrary order. Undated rows sort last, in the order the relay sent.
  it("sorts undated rows last while keeping the relay's own order", () => {
    const cache: SessionListCache = {
      p1: {
        syncedAt: NOW,
        sessions: [
          { id: "undated-first", title: "a", lastActiveAt: null },
          { id: "undated-second", title: "b", lastActiveAt: null },
          { id: "dated", title: "c", lastActiveAt: at("2026-03-14T09:00:00") },
        ],
      },
    };
    const merged = mergeProfileSessions(cache, new Set(["p1"]));
    expect(merged.map((entry) => entry.id)).toEqual(["dated", "undated-first", "undated-second"]);
  });
});

describe("mergeProfileSessions", () => {
  const cache: SessionListCache = {
    work: {
      syncedAt: NOW,
      sessions: [
        { id: "w-new", title: "work newer", lastActiveAt: at("2026-03-15T14:00:00") },
        { id: "w-old", title: "work older", lastActiveAt: at("2026-03-10T09:00:00") },
      ],
    },
    home: {
      syncedAt: NOW,
      sessions: [{ id: "h-mid", title: "home", lastActiveAt: at("2026-03-12T20:00:00") }],
    },
  };

  it("interleaves profiles by recency instead of keeping each profile's list intact", () => {
    const merged = mergeProfileSessions(cache, new Set(["work", "home"]));
    // The per-profile ordering the relay applies survives only within one
    // list — the whole point of the merge is that `home`'s single row lands
    // between `work`'s two, not after them.
    expect(merged.map((entry) => entry.id)).toEqual(["w-new", "h-mid", "w-old"]);
  });

  it("stamps every row with the profile it came from", () => {
    const merged = mergeProfileSessions(cache, new Set(["work", "home"]));
    expect(merged.map((entry) => entry.profileId)).toEqual(["work", "home", "work"]);
  });

  it("returns only the selected profiles", () => {
    const merged = mergeProfileSessions(cache, new Set(["home"]));
    expect(merged.map((entry) => entry.id)).toEqual(["h-mid"]);
  });

  it("ignores cached rows of a profile that is no longer selectable", () => {
    // A profile removed from the device leaves its cache entry behind until
    // something clears it. Rendering those rows would offer sessions nothing
    // can open, since there is no profile left to connect through.
    const withGhost: SessionListCache = { ...cache, removed: { syncedAt: NOW, sessions: [{ id: "ghost", title: "ghost", lastActiveAt: NOW }] } };
    const merged = mergeProfileSessions(withGhost, new Set(["work", "home"]));
    expect(merged.some((entry) => entry.id === "ghost")).toBe(false);
  });

  it("is empty when nothing is selected", () => {
    expect(mergeProfileSessions(cache, new Set())).toEqual([]);
  });
});

describe("groupSessionsByRecency", () => {
  it("buckets by calendar day, not by elapsed hours", () => {
    // Ten minutes apart, either side of midnight: a "24 hours ago" rule
    // would file both under today, which is not how anyone reads their own
    // history.
    const justAfterMidnight = session("after", at("2026-03-15T00:10:00"));
    const justBeforeMidnight = session("before", at("2026-03-14T23:50:00"));
    const groups = groupSessionsByRecency([justAfterMidnight, justBeforeMidnight], NOW);
    expect(groups.map((group) => group.id)).toEqual(["today", "yesterday"]);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["after"]);
    expect(groups[1].sessions.map((entry) => entry.id)).toEqual(["before"]);
  });

  it("puts everything past a week in a final bucket instead of dropping it", () => {
    const ancient = session("ancient", NOW - 400 * DAY);
    const groups = groupSessionsByRecency([ancient], NOW);
    expect(groups).toEqual([{ id: "older", sessions: [ancient] }]);
  });

  it("splits the week and older buckets at the start of the seventh day back", () => {
    const lastDayOfWeekBucket = session("in-week", at("2026-03-09T00:00:00"));
    const firstOlder = session("older", at("2026-03-08T23:59:59"));
    const groups = groupSessionsByRecency([lastDayOfWeekBucket, firstOlder], NOW);
    expect(groups.map((group) => group.id)).toEqual(["week", "older"]);
  });

  it("omits empty buckets entirely", () => {
    const groups = groupSessionsByRecency([session("only", NOW - 3 * DAY)], NOW);
    expect(groups.map((group) => group.id)).toEqual(["week"]);
  });

  it("keeps a future timestamp at the top rather than in a bucket of its own", () => {
    // Clock skew between the relay's machine and this device is ordinary,
    // and a row that quietly disappears because its timestamp is 40 seconds
    // ahead would be impossible to explain.
    const skewed = session("skewed", NOW + 60_000);
    const groups = groupSessionsByRecency([skewed, session("normal", NOW - 60_000)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("today");
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["skewed", "normal"]);
  });

  it("preserves the incoming order inside each bucket", () => {
    const sessions = [session("a", NOW - 1000), session("b", NOW - 2000), session("c", NOW - 3000)];
    const groups = groupSessionsByRecency(sessions, NOW);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupSessionsByRecency([], NOW)).toEqual([]);
  });

  // A relay older than the release that put `lastActiveAt` on the wire is a
  // normal state for a self-hosted install, which updates the two sides
  // separately. Every row of such a list has no timestamp at all, and the
  // whole sidebar has to keep working — this used to throw while formatting
  // the row, which unmounts the entire app, not just the list.
  it("files a session with no timestamp under \"older\"", () => {
    const groups = groupSessionsByRecency([session("undated", null), session("today", NOW - 1000)], NOW);
    expect(groups.map((group) => group.id)).toEqual(["today", "older"]);
    expect(groups[1].sessions.map((entry) => entry.id)).toEqual(["undated"]);
  });
});
