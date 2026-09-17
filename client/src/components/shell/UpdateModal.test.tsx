import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { InstallOrigin } from "@/lib/install/appUpdate";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => {
    openUrl(...args);
  },
}));

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => {
    relaunch(...args);
  },
}));

const UNKNOWN_ORIGIN: InstallOrigin = { channel: "unknown", updatable: false, execPath: "", marker: null };

const { getInstallOriginMock } = vi.hoisted(() => ({
  getInstallOriginMock: vi.fn(
    (): Promise<InstallOrigin> => Promise.resolve({ channel: "unknown", updatable: false, execPath: "", marker: null }),
  ),
}));
vi.mock("@/lib/install/appUpdate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/install/appUpdate")>();
  return { ...actual, getInstallOrigin: getInstallOriginMock };
});

import { UpdateModal } from "@/components/shell/UpdateModal";
import { clearDownloadedUpdate, clearUpdate, markUpdateAvailable, performUpdateCheck } from "@/lib/install/appUpdate";
import { APP_VERSION } from "@/lib/install/appVersion";
import { readSettings, writeSettings } from "@/lib/settings";
import type { Update } from "@/lib/install/updaterPlugin";

const copy = en.shell.updateModal;

/** Same reasoning as appUpdate.test.ts's own `fakeUpdate` — `Update` is a
 * real Tauri plugin class, this only fakes the members the modal and
 * `installAndRestart` actually touch. */
function fakeUpdate(version: string, install: () => Promise<void> = vi.fn()): Update {
  return { version, install, close: vi.fn() } as unknown as Update;
}

const UPDATABLE_ORIGIN: InstallOrigin = { channel: "appimage", updatable: true, execPath: "/x", marker: null };

afterEach(() => {
  cleanup();
  clearUpdate();
  clearDownloadedUpdate();
  localStorage.clear();
  openUrl.mockClear();
  relaunch.mockClear();
  getInstallOriginMock.mockClear();
  getInstallOriginMock.mockResolvedValue(UNKNOWN_ORIGIN);
});

describe("UpdateModal", () => {
  it("reports up to date when no update is available", () => {
    render(<UpdateModal open onOpenChange={() => {}} />);

    expect(screen.getByText(copy.upToDateTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.upToDateBody.replace("{version}", APP_VERSION))).toBeInTheDocument();
  });

  it("shows the version once an update is marked available", () => {
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateModal open onOpenChange={() => {}} />);

    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.body.replace("{version}", "999.0.0").replace("{current}", APP_VERSION))).toBeInTheDocument();
  });

  it("opens the release page when there's no install.sh marker", async () => {
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateModal open onOpenChange={() => {}} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: copy.viewRelease }));

    expect(openUrl).toHaveBeenCalledWith("https://example.test/r");
  });

  it("offers to copy the install command, with a restart hint, when the marker says install.sh", async () => {
    getInstallOriginMock.mockResolvedValue({
      channel: "appimage",
      updatable: true,
      execPath: "/x/anywh.AppImage",
      marker: {
        version: 1,
        method: "install.sh",
        channel: "appimage",
        path: "/x/anywh.AppImage",
        installedVersion: "0.1.7",
        installedAt: "2026-01-01T00:00:00Z",
      },
    });
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateModal open onOpenChange={() => {}} />);

    expect(await screen.findByRole("button", { name: copy.copyCommand })).toBeInTheDocument();
    expect(screen.getByText(copy.restartHint)).toBeInTheDocument();

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.copyCommand }));

    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://anywh.sh/install | sh");
    expect(await screen.findByRole("button", { name: copy.copied })).toBeInTheDocument();
  });

  it("defaults to checking automatically, and persists turning it off", async () => {
    render(<UpdateModal open onOpenChange={() => {}} />);
    const user = userEvent.setup();

    expect(screen.getByRole("radio", { name: copy.checkAutomaticallyOn })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: copy.checkAutomaticallyOff }));

    expect(screen.getByRole("radio", { name: copy.checkAutomaticallyOff })).toHaveAttribute("aria-checked", "true");
    expect(readSettings().app?.updateMode).toBe("off");
  });

  it("doesn't offer auto-download on an origin that can't apply one", () => {
    render(<UpdateModal open onOpenChange={() => {}} />);
    expect(screen.queryByRole("radio", { name: copy.checkAutomaticallyAutoDownload })).not.toBeInTheDocument();
  });

  it("offers and persists auto-download once the origin says it's updatable", async () => {
    getInstallOriginMock.mockResolvedValue(UPDATABLE_ORIGIN);
    render(<UpdateModal open onOpenChange={() => {}} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("radio", { name: copy.checkAutomaticallyAutoDownload }));

    expect(readSettings().app?.updateMode).toBe("auto-download");
  });

  it("shows the ready-to-restart state once auto-download has fetched an update, and installs+relaunches on click", async () => {
    getInstallOriginMock.mockResolvedValue(UPDATABLE_ORIGIN);
    writeSettings({ ...readSettings(), app: { updateMode: "auto-download" } });

    const install = vi.fn().mockResolvedValue(undefined);
    await performUpdateCheck(Date.now(), {
      getInstallOrigin: () => Promise.resolve(UPDATABLE_ORIGIN),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0", install)),
    });

    render(<UpdateModal open onOpenChange={() => {}} />);

    expect(screen.getByText(copy.readyTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.readyBody.replace("{version}", "999.0.0"))).toBeInTheDocument();
    // The plain "available" action never renders once a download is ready —
    // there's nothing left to view a release page or copy a command for.
    expect(screen.queryByRole("button", { name: copy.viewRelease })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: copy.restartNow }));

    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
