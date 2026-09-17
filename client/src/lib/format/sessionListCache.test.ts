import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "anywh:session-list-cache";

/** Re-imported per test: the module keeps its map at module scope (and
 * hydrates it from `localStorage` on first evaluation), so a test about what
 * survives a restart has to get a genuinely fresh evaluation, not a handle
 * on the copy a previous test already mutated. */
async function freshModule() {
  vi.resetModules();
  return import("@/lib/format/sessionListCache");
}

beforeEach(() => {
  localStorage.clear();
});

describe("sessionListCache", () => {
  it("reports a never-synced profile as empty with a null syncedAt", async () => {
    const cache = await freshModule();
    expect(cache.getCachedSessions("unknown")).toEqual({ sessions: [], syncedAt: null });
  });

  it("records syncedAt when a full list is stored", async () => {
    const cache = await freshModule();
    const before = Date.now();
    cache.setCachedSessions("work", [{ id: "s1", title: "One", lastActiveAt: 10 }]);
    const stored = cache.getCachedSessions("work");
    expect(stored.sessions).toHaveLength(1);
    expect(stored.syncedAt).toBeGreaterThanOrEqual(before);
  });

  it("keeps each profile's rows under its own key", async () => {
    const cache = await freshModule();
    cache.setCachedSessions("work", [{ id: "w", title: "Work", lastActiveAt: 2 }]);
    cache.setCachedSessions("home", [{ id: "h", title: "Home", lastActiveAt: 1 }]);
    expect(cache.getCachedSessions("work").sessions.map((s) => s.id)).toEqual(["w"]);
    expect(cache.getCachedSessions("home").sessions.map((s) => s.id)).toEqual(["h"]);
  });

  it("survives a restart", async () => {
    const first = await freshModule();
    first.setCachedSessions("work", [{ id: "s1", title: "One", lastActiveAt: 10 }]);

    // The entire reason this cache is persisted: a profile the app is not
    // connected to has to still have rows in the sidebar on the next launch,
    // before anything reaches its relay.
    const second = await freshModule();
    expect(second.getCachedSessions("work").sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(second.getCachedSessions("work").syncedAt).not.toBeNull();
  });

  it("discards a malformed persisted entry instead of rendering it", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ work: { sessions: [{ id: "s1" }], syncedAt: 1 } }));
    const cache = await freshModule();
    // A row missing `lastActiveAt` has nothing to group on and would crash
    // the date bucketing — dropping it is the only safe read.
    expect(cache.getCachedSessions("work")).toEqual({ sessions: [], syncedAt: null });
  });

  it("ignores storage that isn't even JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "not json at all");
    const cache = await freshModule();
    expect(cache.getSessionListCache()).toEqual({});
  });

  it("notifies subscribers on a write and stops after unsubscribe", async () => {
    const cache = await freshModule();
    const listener = vi.fn();
    const unsubscribe = cache.subscribeSessionListCache(listener);

    cache.setCachedSessions("work", []);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    cache.setCachedSessions("work", [{ id: "s", title: "S", lastActiveAt: 1 }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands out a new map identity on every write, so useSyncExternalStore sees the change", async () => {
    const cache = await freshModule();
    const before = cache.getSessionListCache();
    cache.setCachedSessions("work", []);
    expect(cache.getSessionListCache()).not.toBe(before);
  });

  describe("incremental mirrors", () => {
    it("inserts a newly titled session at the top", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [{ id: "old", title: "Old", lastActiveAt: 100 }]);
      cache.upsertCachedSession("work", "fresh", "Fresh", 200);
      expect(cache.getCachedSessions("work").sessions.map((s) => s.id)).toEqual(["fresh", "old"]);
    });

    it("renames in place without reordering or restamping", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [
        { id: "a", title: "A", lastActiveAt: 200 },
        { id: "b", title: "B", lastActiveAt: 100 },
      ]);
      cache.upsertCachedSession("work", "b", "B renamed", Date.now());

      const { sessions } = cache.getCachedSessions("work");
      // Renaming is not activity: were the timestamp applied, an old
      // conversation would jump into "today" the moment its title was fixed.
      expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
      expect(sessions[1]).toEqual({ id: "b", title: "B renamed", lastActiveAt: 100 });
    });

    it("does not move syncedAt on an incremental write", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", []);
      const syncedAt = cache.getCachedSessions("work").syncedAt;

      cache.upsertCachedSession("work", "s", "S", 1);
      cache.touchCachedSession("work", "s");
      cache.removeCachedSession("work", "s");

      // A single row changing rides on a connection that was already live —
      // treating it as a sync would make the profile look freshly checked.
      expect(cache.getCachedSessions("work").syncedAt).toBe(syncedAt);
    });

    it("removes a deleted session", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [
        { id: "a", title: "A", lastActiveAt: 2 },
        { id: "b", title: "B", lastActiveAt: 1 },
      ]);
      cache.removeCachedSession("work", "a");
      expect(cache.getCachedSessions("work").sessions.map((s) => s.id)).toEqual(["b"]);
    });

    it("does not notify when removing something that was never there", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [{ id: "a", title: "A", lastActiveAt: 2 }]);
      const listener = vi.fn();
      cache.subscribeSessionListCache(listener);
      cache.removeCachedSession("work", "never-existed");
      expect(listener).not.toHaveBeenCalled();
    });

    it("moves a re-used session to the top with a fresh timestamp", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [
        { id: "recent", title: "Recent", lastActiveAt: 200 },
        { id: "stale", title: "Stale", lastActiveAt: 100 },
      ]);
      cache.touchCachedSession("work", "stale");

      const { sessions } = cache.getCachedSessions("work");
      expect(sessions.map((s) => s.id)).toEqual(["stale", "recent"]);
      // Order and timestamp have to agree, or the row would render at the
      // top of the list under a "7 days" heading.
      expect(sessions[0].lastActiveAt).toBeGreaterThan(sessions[1].lastActiveAt ?? 0);
    });

    it("ignores a touch for a session that isn't listed yet", async () => {
      const cache = await freshModule();
      cache.setCachedSessions("work", [{ id: "a", title: "A", lastActiveAt: 1 }]);
      // An untitled session (first turn still running) is not in the relay's
      // list either — nothing to move.
      cache.touchCachedSession("work", "untitled");
      expect(cache.getCachedSessions("work").sessions.map((s) => s.id)).toEqual(["a"]);
    });
  });

  it("forgets a profile's rows when it is removed from the device", async () => {
    const cache = await freshModule();
    cache.setCachedSessions("work", [{ id: "a", title: "A", lastActiveAt: 1 }]);
    cache.forgetCachedProfile("work");
    expect(cache.getCachedSessions("work")).toEqual({ sessions: [], syncedAt: null });

    // And stays forgotten across a restart, or re-pairing the same id would
    // resurrect rows from a device relationship that no longer exists.
    const restarted = await freshModule();
    expect(restarted.getCachedSessions("work").sessions).toEqual([]);
  });
});
