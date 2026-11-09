import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateRestartButton } from "@/components/shell/UpdateRestartButton";
import { en } from "@/i18n/en";
import { clearReadyUpdate, performUpdateCheck } from "@/lib/install/appUpdate";
import { readSettings, writeSettings } from "@/lib/settings";
import type { Update } from "@/lib/install/updaterPlugin";

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => {
    relaunch(...args);
  },
}));

const copy = en.shell.titleBar;

function fakeUpdate(version: string, install: () => Promise<void>): Update {
  return { version, install, close: vi.fn() } as unknown as Update;
}

/** Runs a real scheduled check that downloads `version` and, when
 * `installsInBackground`, installs it — the state the button reacts to. */
async function downloadUpdate(install: () => Promise<void>, installsInBackground: boolean): Promise<void> {
  writeSettings({ ...readSettings(), app: { updateMode: "auto-download" } });
  await act(() =>
    performUpdateCheck(Date.now(), {
      getInstallOrigin: () => Promise.resolve({ channel: "appimage", updatable: true, execPath: "/x", marker: null }),
      checkLatestRelease: () =>
        Promise.resolve({ kind: "available", tagName: "v999.0.0", htmlUrl: "https://example.test/r", etag: null }),
      downloadUpdate: () => Promise.resolve(fakeUpdate("999.0.0", install)),
      installUpdate: (update) => update.install(),
      installsInBackground,
      appVersion: "0.2.0",
    }),
  );
}

const button = () => (
  <TooltipProvider>
    <UpdateRestartButton />
  </TooltipProvider>
);

afterEach(() => {
  cleanup();
  clearReadyUpdate();
  localStorage.clear();
  relaunch.mockClear();
});

describe("UpdateRestartButton", () => {
  it("renders nothing until an update is ready", () => {
    render(button());
    expect(screen.queryByRole("button", { name: copy.restartToUpdate })).toBeNull();
  });

  it("appears on its own once the update is installed, and only relaunches", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    render(button());
    await downloadUpdate(install, true);

    await userEvent.setup().click(screen.getByRole("button", { name: copy.restartToUpdate }));

    expect(install).toHaveBeenCalledTimes(1); // by the check, not the click
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("installs on the click where the install had to wait", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    render(button());
    await downloadUpdate(install, false);
    expect(install).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole("button", { name: copy.restartToUpdate }));

    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("can be dismissed", async () => {
    render(button());
    await downloadUpdate(vi.fn().mockResolvedValue(undefined), true);

    await userEvent.setup().click(screen.getByRole("button", { name: copy.dismissRestartToUpdate }));

    expect(screen.queryByRole("button", { name: copy.restartToUpdate })).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
