import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/install/appVersion";
import type { Update } from "@/lib/install/updaterPlugin";

// Git keeps APP_VERSION at the unreleased placeholder, which never checks for
// updates; everything here but the tests about that placeholder is about a
// released app, so this is the app as a release build sees itself.
vi.mock("@/lib/install/appVersion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/install/appVersion")>();
  return { ...actual, APP_VERSION: "0.2.0" };
});

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
  return { version, close, install: vi.fn() } as unknown as Update;
}

beforeEach(() => {
  localStorage.clear();
});

describe("isCheckDue", () => {
  it("is due when never checked before", async () => {
    const { isCheckDue } = await freshModule();
    expect(isCheckDue(undefined, Date.now())).toBe(true);
  });

  it("checks every 4 hours", async () => {
    const { isCheckDue, UPDATE_CHECK_INTERVAL_MS } = await freshModule();
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(4 * hour);
    expect(isCheckDue({ lastCheckedAt: now - 60_000 }, now)).toBe(false);
    expect(isCheckDue({ lastCheckedAt: now - 3 * hour }, now)).toBe(false);
    expect(isCheckDue({ lastCheckedAt: now - 5 * hour }, now)).toBe(true);
  });

  it("off suppresses everything regardless of timing", async () => {
    const { isCheckDue } = await freshModule();
    expect(isCheckDue({ updateMode: "off", lastCheckedAt: 0 }, Date.now())).toBe(false);
  });

  it("respects a rate-limit backoff even when the cadence has elapsed", async () => {
    const { isCheckDue } = await freshModule();
    const now = Date.now();
    expect(isCheckDue({ lastCheckedAt: 0, nextCheckAllowedAt: now + 60_000 }, now)).toBe(false);
    expect(isCheckDue({ lastCheckedAt: 0, nextCheckAllowedAt: now - 60_000 }, now)).toBe(true);
  });
});

describe("resolveUpdateMode", () => {
  it("defaults to automatic only where the install can replace itself", async () => {
    const { resolveUpdateMode } = await freshModule();
    expect(resolveUpdateMode(undefined, true)).toBe("auto-download");
    expect(resolveUpdateMode(undefined, false)).toBe("notify");
  });

  it("keeps an explicit off or notify, on any origin", async () => {
    const { resolveUpdateMode } = await freshModule();
    expect(resolveUpdateMode("off", true)).toBe("off");
    expect(resolveUpdateMode("off", false)).toBe("off");
    expect(resolveUpdateMode("notify", true)).toBe("notify");
    expect(resolveUpdateMode("notify", false)).toBe("notify");
  });

  it("honours a saved automatic mode only on an updatable origin", async () => {
    const { resolveUpdateMode } = await freshModule();
    expect(resolveUpdateMode("auto-download", true)).toBe("auto-download");
    expect(resolveUpdateMode("auto-download", false)).toBe("notify");
  });
});

describe("performUpdateCheck", () => {
  const fakeOrigin = (updatable: boolean) => () =>
    Promise.resolve({ channel: "appimage", updatable, execPath: "/x", marker: null });
  const noDownload = () => Promise.resolve(null);
  const NEWER = { kind: "available" as const, tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null };

  it("never asks GitHub from a build no release stamped", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    const checkLatestRelease = vi.fn();
    const downloadUpdate = vi.fn();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });

    await appUpdate.forceUpdateCheck({ getInstallOrigin: fakeOrigin(true), checkLatestRelease, downloadUpdate, appVersion: "0.0.0" });

    expect(checkLatestRelease).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(appUpdate.getAvailableUpdate()).toBeNull();
    expect(settings.readSettings().app?.lastCheckedAt).toBeGreaterThanOrEqual(now);
  });

  it("still checks from the e2e build's forced origin, which stands in for an installed release", async () => {
    const appUpdate = await freshModule();
    await appUpdate.forceUpdateCheck({
      getInstallOrigin: () => Promise.resolve({ channel: "e2e", updatable: true, execPath: "/x", marker: null }),
      checkLatestRelease: () => Promise.resolve({ kind: "available", tagName: "v99.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: noDownload,
      appVersion: "0.0.0",
    });
    expect(appUpdate.getAvailableUpdate()).toEqual({ version: "99.0.0", htmlUrl: "https://example.test/r" });
  });

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

  it("neither downloads nor rewrites a saved auto-download the origin can't honour", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    const downloadUpdate = vi.fn(noDownload);

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(false),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate,
    });

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(appUpdate.getAvailableUpdate()?.version).toBe("999.0.0");
    expect(settings.readSettings().app?.updateMode).toBe("auto-download");
  });

  it.each([
    { updatable: true, downloads: 1 },
    { updatable: false, downloads: 0 },
  ])("with no saved mode and updatable=$updatable, downloads $downloads time(s) and always notifies", async ({ updatable, downloads }) => {
    const appUpdate = await freshModule();
    const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(updatable),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate,
      installUpdate: () => Promise.resolve(),
      installsInBackground: true,
    });

    expect(downloadUpdate).toHaveBeenCalledTimes(downloads);
    expect(appUpdate.getAvailableUpdate()?.version).toBe("999.0.0");
  });

  it("installs right after the download where the platform allows it", async () => {
    const appUpdate = await freshModule();
    const order: string[] = [];
    const update = fakeUpdate("999.0.0");

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate: () => {
        order.push("download");
        return Promise.resolve(update);
      },
      installUpdate: () => {
        order.push("install");
        return Promise.resolve();
      },
      installsInBackground: true,
    });

    expect(order).toEqual(["download", "install"]);
    expect(appUpdate.getReadyUpdate()).toMatchObject({ update, installed: true, dismissed: false });
  });

  it("defers the install where it would end the process (Windows)", async () => {
    const appUpdate = await freshModule();
    const installUpdate = vi.fn(() => Promise.resolve());
    const update = fakeUpdate("999.0.0");

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate: () => Promise.resolve(update),
      installUpdate,
      installsInBackground: false,
    });

    expect(installUpdate).not.toHaveBeenCalled();
    expect(appUpdate.getReadyUpdate()).toMatchObject({ update, installed: false });
  });

  it("keeps a failed install as downloaded, so the restart installs it", async () => {
    const appUpdate = await freshModule();
    const update = fakeUpdate("999.0.0");

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate: () => Promise.resolve(update),
      installUpdate: () => Promise.reject(new Error("disk full")),
      installsInBackground: true,
    });

    expect(appUpdate.getReadyUpdate()).toMatchObject({ update, installed: false });
  });

  it("downloads and marks the update ready in a saved auto-download mode when the release is newer", async () => {
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
      installUpdate: () => Promise.resolve(),
      installsInBackground: true,
    });

    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(appUpdate.getReadyUpdate()?.update).toBe(update);
  });

  it("never downloads in a saved notify mode, even on an updatable origin", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    const now = Date.now();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "notify" } });
    const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));

    await appUpdate.performUpdateCheck(now, {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate,
    });

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(appUpdate.getReadyUpdate()).toBeNull();
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

  it("reports the download state: downloading, then idle once ready", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    const seen: string[] = [];
    appUpdate.subscribeUpdateActivity(() => seen.push(appUpdate.getUpdateActivity().download));

    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: fakeOrigin(true),
      checkLatestRelease: () => Promise.resolve(NEWER),
      downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0")),
    });

    expect(seen).toEqual(["downloading", "idle"]);
  });

  it("reports a failed or empty download as failed, and never claims one in notify mode", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    const base = { getInstallOrigin: fakeOrigin(true), checkLatestRelease: () => Promise.resolve(NEWER) };

    await appUpdate.performUpdateCheck(Date.now(), { ...base, downloadUpdate: () => Promise.reject(new Error("x")) });
    expect(appUpdate.getUpdateActivity().download).toBe("failed");

    await appUpdate.forceUpdateCheck({ ...base, downloadUpdate: () => Promise.resolve(null) });
    expect(appUpdate.getUpdateActivity().download).toBe("failed");

    const notify = await freshModule();
    const s2 = await freshSettings();
    s2.writeSettings({ ...s2.readSettings(), app: { updateMode: "notify" } });
    await notify.forceUpdateCheck({ ...base, downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0")) });
    expect(notify.getUpdateActivity().download).toBe("idle");
  });

  it("joins a manual check that is already running instead of starting a second one", async () => {
    const appUpdate = await freshModule();
    let release: (check: { kind: "notModified" }) => void = () => {};
    const checkLatestRelease = vi.fn(
      () =>
        new Promise<{ kind: "notModified" }>((resolve) => {
          release = resolve;
        }),
    );
    const deps = { getInstallOrigin: fakeOrigin(true), checkLatestRelease, downloadUpdate: noDownload };

    const first = appUpdate.forceUpdateCheck(deps);
    const second = appUpdate.forceUpdateCheck(deps);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(checkLatestRelease).toHaveBeenCalledTimes(1));
    expect(appUpdate.getUpdateActivity().checking).toBe(true);

    release({ kind: "notModified" });
    await first;
    expect(checkLatestRelease).toHaveBeenCalledTimes(1);
    expect(appUpdate.getUpdateActivity().checking).toBe(false);

    // Once finished, the next press is a new check.
    void appUpdate.forceUpdateCheck(deps);
    await vi.waitFor(() => expect(checkLatestRelease).toHaveBeenCalledTimes(2));
  });

  describe("retrying a download that never arrived", () => {
    const notModified = () => Promise.resolve({ kind: "notModified" as const });

    async function setup() {
      const appUpdate = await freshModule();
      const settings = await freshSettings();
      settings.writeSettings({
        ...settings.readSettings(),
        app: { updateMode: "auto-download" },
      });
      return { appUpdate, settings };
    }

    it("retries after a failed download even though the next check is 'not modified'", async () => {
      const { appUpdate, settings } = await setup();
      const downloadUpdate = vi
        .fn<() => Promise<Update | null>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(fakeUpdate("999.0.0"));
      const base = { getInstallOrigin: fakeOrigin(true), downloadUpdate };

      await appUpdate.performUpdateCheck(Date.now(), {
        ...base,
        checkLatestRelease: () => Promise.resolve(NEWER),
      });
      expect(appUpdate.getReadyUpdate()).toBeNull();
      expect(settings.readSettings().app?.lastSeenVersion).toBe("999.0.0");

      await appUpdate.forceUpdateCheck({
        ...base,
        checkLatestRelease: notModified,
      });
      expect(downloadUpdate).toHaveBeenCalledTimes(2);
      expect(appUpdate.getReadyUpdate()?.update.version).toBe("999.0.0");
    });

    it("retries after a download that came back empty", async () => {
      const { appUpdate } = await setup();
      const downloadUpdate = vi
        .fn<() => Promise<Update | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fakeUpdate("999.0.0"));
      const base = { getInstallOrigin: fakeOrigin(true), downloadUpdate };

      await appUpdate.performUpdateCheck(Date.now(), {
        ...base,
        checkLatestRelease: () => Promise.resolve(NEWER),
      });
      await appUpdate.forceUpdateCheck({
        ...base,
        checkLatestRelease: notModified,
      });

      expect(appUpdate.getReadyUpdate()?.update.version).toBe("999.0.0");
    });

    it("retries on a fresh launch, where the in-memory update store is empty", async () => {
      const { appUpdate, settings } = await setup();
      settings.writeSettings({
        ...settings.readSettings(),
        app: {
          updateMode: "auto-download",
          lastSeenVersion: "999.0.0",
          etag: "e",
        },
      });
      const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));

      await appUpdate.forceUpdateCheck({
        getInstallOrigin: fakeOrigin(true),
        checkLatestRelease: notModified,
        downloadUpdate,
      });

      expect(downloadUpdate).toHaveBeenCalledOnce();
      expect(appUpdate.getAvailableUpdate()?.version).toBe("999.0.0");
    });

    it("does not download again once the version is ready", async () => {
      const { appUpdate } = await setup();
      const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("999.0.0")));
      const base = { getInstallOrigin: fakeOrigin(true), downloadUpdate };

      await appUpdate.performUpdateCheck(Date.now(), {
        ...base,
        checkLatestRelease: () => Promise.resolve(NEWER),
      });
      await appUpdate.forceUpdateCheck({
        ...base,
        checkLatestRelease: notModified,
      });

      expect(downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it("does nothing on 'not modified' when the last seen version is not newer, or the mode is not automatic", async () => {
      const { appUpdate, settings } = await setup();
      const downloadUpdate = vi.fn(() => Promise.resolve(fakeUpdate("0.1.0")));
      settings.writeSettings({
        ...settings.readSettings(),
        app: { updateMode: "auto-download", lastSeenVersion: "0.1.0" },
      });
      await appUpdate.forceUpdateCheck({
        getInstallOrigin: fakeOrigin(true),
        checkLatestRelease: notModified,
        downloadUpdate,
      });

      settings.writeSettings({
        ...settings.readSettings(),
        app: { updateMode: "notify", lastSeenVersion: "999.0.0" },
      });
      await appUpdate.forceUpdateCheck({
        getInstallOrigin: fakeOrigin(true),
        checkLatestRelease: notModified,
        downloadUpdate,
      });

      expect(downloadUpdate).not.toHaveBeenCalled();
    });
  });
});

describe("ready update", () => {
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
    expect(appUpdate.getReadyUpdate()?.update).toBe(first);

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
    expect(appUpdate.getReadyUpdate()?.update).toBe(second);
  });

  it("notifies subscribers and clears on clearReadyUpdate", async () => {
    const appUpdate = await freshModule();
    const listener = vi.fn();
    const unsubscribe = appUpdate.subscribeReadyUpdate(listener);

    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    await appUpdate.performUpdateCheck(Date.now(), {
      getInstallOrigin: () => Promise.resolve({ channel: "appimage", updatable: true, execPath: "/x", marker: null }),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available" as const, tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0")),
    });
    expect(listener).toHaveBeenCalledTimes(1);

    appUpdate.clearReadyUpdate();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(appUpdate.getReadyUpdate()).toBeNull();

    unsubscribe();
  });

  it("dismissing hides the prompt for this update only", async () => {
    const appUpdate = await freshModule();
    const settings = await freshSettings();
    settings.writeSettings({ ...settings.readSettings(), app: { updateMode: "auto-download" } });
    const run = (version: string, at: number) =>
      appUpdate.performUpdateCheck(at, {
        getInstallOrigin: () => Promise.resolve({ channel: "appimage", updatable: true, execPath: "/x", marker: null }),
        checkLatestRelease: () =>
          Promise.resolve({ kind: "available" as const, tagName: `v${version}`, htmlUrl: "https://example.test/r", etag: null }),
        downloadUpdate: () => Promise.resolve(fakeUpdate(version)),
        installUpdate: () => Promise.resolve(),
        installsInBackground: true,
      });

    await run("999.0.0", Date.now());
    appUpdate.dismissRestartPrompt();
    expect(appUpdate.getReadyUpdate()?.dismissed).toBe(true);

    await run("999.0.1", Date.now() + 5 * 60 * 60 * 1000);
    expect(appUpdate.getReadyUpdate()).toMatchObject({ dismissed: false });
    expect(appUpdate.getReadyUpdate()?.update.version).toBe("999.0.1");
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
