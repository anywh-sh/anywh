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
        app: { updateMode: "auto-download", updateModeVersion: 1, lastSeenVersion: "0.1.8" },
      }),
    );
    const settings = await freshModule();
    expect(settings.readSettings().app).toEqual({
      updateMode: "auto-download",
      updateModeVersion: 1,
      lastSeenVersion: "0.1.8",
    });
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

describe("settings store: the update-mode migration", () => {
  const seed = (app: Record<string, unknown>) =>
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, global: {}, byProfile: {}, app }));

  it("drops a notify saved by a build before the marker, which the user never chose", async () => {
    seed({ updateMode: "notify", etag: "e" });
    const settings = await freshModule();
    expect(settings.readSettings().app).toEqual({ etag: "e", updateModeVersion: settings.UPDATE_MODE_VERSION });
  });

  it("keeps a saved off and auto-download, stamping the marker", async () => {
    seed({ updateMode: "off" });
    expect((await freshModule()).readSettings().app).toMatchObject({ updateMode: "off", updateModeVersion: 1 });
    seed({ updateMode: "auto-download" });
    expect((await freshModule()).readSettings().app).toMatchObject({ updateMode: "auto-download" });
  });

  it("honours a notify saved at the current version", async () => {
    seed({ updateMode: "notify", updateModeVersion: 1 });
    expect((await freshModule()).readSettings().app).toEqual({ updateMode: "notify", updateModeVersion: 1 });
  });

  it("runs once: persists the migration, so a notify picked afterwards survives a reload", async () => {
    seed({ updateMode: "notify" });
    const first = await freshModule();
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { app?: { updateModeVersion?: number } };
    expect(persisted.app?.updateModeVersion).toBe(1);
    first.writeSettings({
      ...first.readSettings(),
      app: { ...first.readSettings().app, updateMode: "notify", updateModeVersion: first.UPDATE_MODE_VERSION },
    });
    expect((await freshModule()).readSettings().app?.updateMode).toBe("notify");
  });

  it("leaves a store with no app field alone", async () => {
    const settings = await freshModule();
    expect(settings.readSettings().app).toBeUndefined();
  });
});
