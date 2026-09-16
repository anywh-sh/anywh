import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "anywh:settings";

/** Same reasoning as sessionListCache.test.ts's own `freshModule` — the
 * store is hydrated from `localStorage` once, at module scope, on first
 * evaluation. A test about what a given persisted shape loads into has to
 * force a genuinely fresh evaluation, not read a previous test's copy. */
async function freshModule() {
  vi.resetModules();
  return import("@/lib/settings");
}

beforeEach(() => {
  localStorage.clear();
});

describe("settings store: the app-wide app field", () => {
  it("validates a store from before this field existed, with no version bump needed", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, global: {}, byProfile: { home: { defaultPath: "/x" } } }),
    );
    const settings = await freshModule();
    const store = settings.readSettings();
    expect(store.byProfile.home).toEqual({ defaultPath: "/x" });
    expect(store.app).toBeUndefined();
  });

  it("loads a well-formed app field", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        global: {},
        byProfile: {},
        app: { updateMode: "auto-download", lastSeenVersion: "0.1.8" },
      }),
    );
    const settings = await freshModule();
    expect(settings.readSettings().app).toEqual({ updateMode: "auto-download", lastSeenVersion: "0.1.8" });
  });

  it("falls back to undefined on a corrupted app field without dropping byProfile", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        global: {},
        byProfile: { home: { defaultPath: "/x" } },
        app: { updateMode: "not-a-real-mode" },
      }),
    );
    const settings = await freshModule();
    const store = settings.readSettings();
    expect(store.byProfile.home).toEqual({ defaultPath: "/x" });
    expect(store.app).toBeUndefined();
  });

  it("rejects the whole store, as before, when global or byProfile themselves are malformed", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, global: "not an object", byProfile: {} }));
    const settings = await freshModule();
    expect(settings.readSettings()).toEqual({ version: 1, global: {}, byProfile: {} });
  });
});
