import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/appVersion";

/** Same reasoning as sessionListCache.test.ts/settings.test.ts: the update
 * store keeps `current` at module scope, so a test about what a previous
 * check left behind needs a genuinely fresh evaluation. */
async function freshModule() {
  vi.resetModules();
  return import("@/lib/appUpdate");
}

async function freshSettings() {
  return import("@/lib/settings");
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
  const fakeOrigin = (updatable: boolean) => async () => ({ channel: "appimage", updatable, execPath: "/x", marker: null });

  it("does nothing when not due", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    settings.writeSettings({ ...settings.readSettings(), app: { lastCheckedAt: now } });

    const checkLatestRelease = vi.fn();
    await appUpdate.performUpdateCheck(now, { getInstallOrigin: fakeOrigin(true), checkLatestRelease });

    expect(checkLatestRelease).not.toHaveBeenCalled();
  });

  it("marks an update available when the release is newer than APP_VERSION", async () => {
    const appUpdate = await freshModule();
    const now = Date.now();

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: async () => ({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: "\"abc\"" }),
    });

    expect(appUpdate.getAvailableUpdate()).toEqual({ version: "999.0.0", htmlUrl: "https://example.test/r" });
  });

  it("never marks an update for a release that isn't actually newer", async () => {
    const appUpdate = await freshModule();
    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: async () => ({ kind: "available", tagName: `v${APP_VERSION}`, htmlUrl: "https://example.test/r", etag: null }),
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
      checkLatestRelease: async () => ({ kind: "rateLimited", retryAfterEpochMs: retryAt }),
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
      checkLatestRelease: async () => ({ kind: "notModified" }),
    });

    expect(settings.readSettings().app?.updateMode).toBe("notify");
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
