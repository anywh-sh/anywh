import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/install/appVersion";
import type { Update } from "@/lib/install/updaterPlugin";

/** Same reasoning as sessionListCache.test.ts/settings.test.ts: the update
 * store keeps `current` at module scope, so a test about what a previous
 * check left behind needs a genuinely fresh evaluation. */
async function freshModule() {
  vi.resetModules();
  return import("@/lib/install/appUpdate");
}

async function freshSettings() {
  return import("@/lib/settings");
}

/** `Update` is a real Tauri plugin class (extends `Resource`) with more
 * fields than any test cares about — this fakes just the two `appUpdate.ts`
 * itself touches (`version`, `close`) and casts past the rest, the same way
 * a hand-rolled `Update` mock would in any test that doesn't go through the
 * real plugin. `close` is a separate parameter rather than always a fresh
 * `vi.fn()` inside, so a test asserting on it can hold its own reference
 * instead of reading `.close` back off the typed `Update` (which
 * `@typescript-eslint/unbound-method` flags as an unbound method access). */
function fakeUpdate(version: string, close: () => Promise<void> = vi.fn()): Update {
  return { version, close } as unknown as Update;
}

beforeEach(() => {
  localStorage.clear();
});

describe("isCheckDue", () => {
  it("is due when never checked before", async () => {
    const { isCheckDue } = await freshModule();
    expect(isCheckDue(undefined, Date.now())).toBe(true);
  });

  it("is not due within 24h of the last check", async () => {
    const { isCheckDue } = await freshModule();
    const now = Date.now();
    expect(isCheckDue({ lastCheckedAt: now - 60_000 }, now)).toBe(false);
    expect(isCheckDue({ lastCheckedAt: now - 25 * 60 * 60 * 1000 }, now)).toBe(true);
  });

  it("off suppresses everything regardless of timing", async () => {
    const { isCheckDue } = await freshModule();
    expect(isCheckDue({ updateMode: "off", lastCheckedAt: 0 }, Date.now())).toBe(false);
  });

  it("respects a rate-limit backoff even when the 24h window has elapsed", async () => {
    const { isCheckDue } = await freshModule();
    const now = Date.now();
    expect(isCheckDue({ lastCheckedAt: 0, nextCheckAllowedAt: now + 60_000 }, now)).toBe(false);
    expect(isCheckDue({ lastCheckedAt: 0, nextCheckAllowedAt: now - 60_000 }, now)).toBe(true);
  });
});

describe("normalizeUpdateMode", () => {
  it("forces auto-download to notify on a non-updatable origin", async () => {
    const { normalizeUpdateMode } = await freshModule();
    expect(normalizeUpdateMode("auto-download", false)).toBe("notify");
  });

  it("leaves every other combination untouched", async () => {
    const { normalizeUpdateMode } = await freshModule();
    expect(normalizeUpdateMode("auto-download", true)).toBe("auto-download");
    expect(normalizeUpdateMode("notify", false)).toBe("notify");
    expect(normalizeUpdateMode("off", false)).toBe("off");
  });
});

describe("performUpdateCheck", () => {
  const fakeOrigin = (updatable: boolean) => () =>
    Promise.resolve({ channel: "appimage", updatable, execPath: "/x", marker: null });
  const noDownload = () => Promise.resolve(null);

  it("does nothing when not due", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    settings.writeSettings({ ...settings.readSettings(), app: { lastCheckedAt: now } });

    const checkLatestRelease = vi.fn();
    const downloadUpdate = vi.fn();
    await appUpdate.performUpdateCheck(now, { getInstallOrigin: fakeOrigin(true), checkLatestRelease, downloadUpdate });

    expect(checkLatestRelease).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("marks an update available when the release is newer than APP_VERSION", async () => {
    const appUpdate = await freshModule();
    const now = Date.now();

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: "\"abc\"" }),
      downloadUpdate: noDownload,
    });

    expect(appUpdate.getAvailableUpdate()).toEqual({ version: "999.0.0", htmlUrl: "https://example.test/r" });
  });

  it("never marks an update for a release that isn't actually newer", async () => {
    const appUpdate = await freshModule();
    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: `v${APP_VERSION}`, htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: noDownload,
    });
    expect(appUpdate.getAvailableUpdate()).toBeNull();
  });

  it("persists nextCheckAllowedAt from a 403 without marking an update", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    const retryAt = now + 3_600_000;

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () => Promise.resolve({ kind: "rateLimited", retryAfterEpochMs: retryAt }),
      downloadUpdate: noDownload,
    });

    expect(appUpdate.getAvailableUpdate()).toBeNull();
    expect(settings.readSettings().app?.nextCheckAllowedAt).toBe(retryAt);
    expect(settings.readSettings().app?.lastCheckedAt).toBe(now);
  });

  it("forces a stored auto-download mode to notify when the origin isn't updatable", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(false),
      checkLatestRelease: () => Promise.resolve({ kind: "notModified" }),
      downloadUpdate: noDownload,
    });

    expect(settings.readSettings().app?.updateMode).toBe("notify");
  });

  it("downloads and marks the update ready in auto-download mode when the release is newer", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });

    const update = fakeUpdate("999.0.0");
    const downloadUpdate = vi.fn(() => Promise.resolve(update));

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate,
    });

    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(appUpdate.getDownloadedUpdate()).toBe(update);
  });

  it("never downloads in notify mode, even when the release is newer", async () => {
    const appUpdate = await freshModule();
    const now = Date.now();
    const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate,
    });

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(appUpdate.getDownloadedUpdate()).toBeNull();
  });

  it("does not re-download a version it has already fetched", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });

    const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));
    const deps = {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available" as const, tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate,
    };

    await appUpdate.performUpdateCheck(Date.now(), deps);
    // Second check is only "due" 24h later, so call runCheck's public
    // equivalent (forceUpdateCheck) directly to exercise the same-version
    // dedupe without needing to fake the clock.
    await appUpdate.forceUpdateCheck(deps);

    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("downloaded update", () => {
  it("closes the previous Update resource when a newer download replaces it", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });

    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const first = fakeUpdate("999.0.0", firstClose);
    const second = fakeUpdate("999.0.1", secondClose);
    const fakeOrigin = () => Promise.resolve({ channel: "appimage", updatable: true, execPath: "/x", marker: null });

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin,
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available" as const, tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(first),
    });
    expect(appUpdate.getDownloadedUpdate()).toBe(first);

    // A day later so the next check is due on its own — exercises the same
    // path performUpdateCheck's 24h interval in App.tsx actually takes.
    await appUpdate.performUpdateCheck(Date.now() + 25 * 60 * 60 * 1000, {
      getInstallOrigin: fakeOrigin,
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available" as const, tagName: "v999.0.1", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(second),
    });

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(appUpdate.getDownloadedUpdate()).toBe(second);
  });

  it("notifies subscribers and clears on clearDownloadedUpdate", async () => {
    const appUpdate = await freshModule();
    const listener = vi.fn();
    const unsubscribe = appUpdate.subscribeDownloadedUpdate(listener);

    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: () => Promise.resolve({ channel: "appimage", updatable: true, execPath: "/x", marker: null }),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available" as const, tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0")),
    });
    expect(listener).toHaveBeenCalledTimes(1);

    appUpdate.clearDownloadedUpdate();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(appUpdate.getDownloadedUpdate()).toBeNull();

    unsubscribe();
  });
});

describe("clearUpdate", () => {
  it("notifies subscribers on every mutation", async () => {
    const appUpdate = await freshModule();
    const listener = vi.fn();
    const unsubscribe = appUpdate.subscribeAppUpdate(listener);

    appUpdate.markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    expect(listener).toHaveBeenCalledTimes(1);

    appUpdate.clearUpdate();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    appUpdate.markUpdateAvailable({ version: "999.0.1", htmlUrl: "https://example.test/r" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
