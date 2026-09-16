import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { InstallOrigin } from "@/lib/appUpdate";

const UPDATABLE_ORIGIN: InstallOrigin = { channel: "appimage", updatable: true, execPath: "/x", marker: null };

const { getInstallOriginMock } = vi.hoisted(() => ({
  getInstallOriginMock: vi.fn(async (): Promise<InstallOrigin> => ({ channel: "appimage", updatable: true, execPath: "/x", marker: null })),
}));
vi.mock("@/lib/appUpdate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appUpdate")>();
  return { ...actual, getInstallOrigin: getInstallOriginMock };
});

import { UpdatesSettings } from "@/components/settings/UpdatesSettings";
import { APP_VERSION } from "@/lib/appVersion";
import { readSettings } from "@/lib/settings";

const copy = en.settings.updates;

afterEach(() => {
  cleanup();
  localStorage.clear();
  getInstallOriginMock.mockClear();
  getInstallOriginMock.mockResolvedValue(UPDATABLE_ORIGIN);
});

describe("UpdatesSettings", () => {
  it("defaults to notify and persists a change to another mode", async () => {
    render(<UpdatesSettings />);
    const user = userEvent.setup();
    expect(screen.getByRole("radio", { name: copy.mode.notify })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: copy.mode.off }));

    expect(screen.getByRole("radio", { name: copy.mode.off })).toHaveAttribute("aria-checked", "true");
    expect(readSettings().app?.updateMode).toBe("off");
  });

  it("switches to auto-download when the origin can apply it", async () => {
    render(<UpdatesSettings />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("radio", { name: copy.mode.autoDownload }));

    expect(readSettings().app?.updateMode).toBe("auto-download");
  });

  it("disables auto-download and explains why when the origin can't apply an update", async () => {
    getInstallOriginMock.mockResolvedValue({
      channel: "system-package",
      updatable: false,
      execPath: "/usr/bin/anywh",
      marker: null,
    });
    render(<UpdatesSettings />);

    const autoDownload = await screen.findByRole("radio", { name: copy.mode.autoDownload });
    expect(autoDownload).toBeDisabled();
    expect(await screen.findByText(copy.notUpdatable)).toBeInTheDocument();
  });

  it("never shows the not-updatable explanation for an origin that can apply an update", async () => {
    render(<UpdatesSettings />);
    await screen.findByRole("radio", { name: copy.mode.autoDownload });
    expect(screen.queryByText(copy.notUpdatable)).not.toBeInTheDocument();
  });

  it("shows the current app version and no check having run yet", () => {
    render(<UpdatesSettings />);
    expect(screen.getByText(APP_VERSION)).toBeInTheDocument();
    expect(screen.getByText(`${copy.lastChecked.label}: ${copy.lastChecked.never}`)).toBeInTheDocument();
  });
});
