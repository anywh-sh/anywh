import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { InstallOrigin } from "@/lib/appUpdate";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

const UNKNOWN_ORIGIN: InstallOrigin = { channel: "unknown", updatable: false, execPath: "", marker: null };

const { getInstallOriginMock } = vi.hoisted(() => ({
  getInstallOriginMock: vi.fn(async (): Promise<InstallOrigin> => ({ channel: "unknown", updatable: false, execPath: "", marker: null })),
}));
vi.mock("@/lib/appUpdate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appUpdate")>();
  return { ...actual, getInstallOrigin: getInstallOriginMock };
});

import { UpdateBanner } from "@/components/shell/UpdateBanner";
import { clearUpdate, markUpdateAvailable } from "@/lib/appUpdate";

const copy = en.shell.update;

afterEach(() => {
  cleanup();
  clearUpdate();
  openUrl.mockClear();
  getInstallOriginMock.mockClear();
  getInstallOriginMock.mockResolvedValue(UNKNOWN_ORIGIN);
});

describe("UpdateBanner", () => {
  it("renders nothing when no update is available", () => {
    render(<UpdateBanner />);
    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("shows the version once an update is marked available", () => {
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateBanner />);
    expect(screen.getByText(copy.eyebrow)).toBeInTheDocument();
    expect(screen.getByText(copy.body.replace("{version}", "999.0.0"))).toBeInTheDocument();
  });

  it("dismisses and disappears without touching any timer", async () => {
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateBanner />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.dismiss }));

    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("opens the release page when there's no install.sh marker", async () => {
    markUpdateAvailable({ version: "999.0.0", htmlUrl: "https://example.test/r" });
    render(<UpdateBanner />);
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
    render(<UpdateBanner />);

    expect(await screen.findByRole("button", { name: copy.copyCommand })).toBeInTheDocument();
    expect(screen.getByText(copy.restartHint)).toBeInTheDocument();

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.copyCommand }));

    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://anywh.sh/install | sh");
    expect(await screen.findByRole("button", { name: copy.copied })).toBeInTheDocument();
  });
});
