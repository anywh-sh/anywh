import { beforeEach, describe, expect, it, vi } from "vitest";

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;

const windowApi = vi.hoisted(() => ({
  handler: null as unknown as CloseHandler,
  destroy: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (handler: CloseHandler) => {
      windowApi.handler = handler;
      return Promise.resolve(() => {});
    },
    destroy: windowApi.destroy,
    close: windowApi.close,
  }),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@/lib/telemetry/instrument", () => ({ trackError: vi.fn() }));

import { installOnClose, restartIntoUpdate, type Update } from "@/lib/install/updaterPlugin";

function fakeUpdate(install: () => Promise<void> = () => Promise.resolve()) {
  const spy = vi.fn(install);
  return { update: { install: spy } as unknown as Update, install: spy };
}

describe("installOnClose", () => {
  beforeEach(() => {
    windowApi.destroy.mockReset().mockResolvedValue(undefined);
    windowApi.close.mockReset().mockResolvedValue(undefined);
  });

  it("installs, then closes the window", async () => {
    const { update, install } = fakeUpdate();
    await installOnClose(update);
    const preventDefault = vi.fn();
    await windowApi.handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(install).toHaveBeenCalled();
    expect(windowApi.destroy).toHaveBeenCalledOnce();
  });

  it("still closes the window when the install fails", async () => {
    const { update } = fakeUpdate(() => Promise.reject(new Error("antivirus")));
    await installOnClose(update);
    await windowApi.handler({ preventDefault: vi.fn() });
    expect(windowApi.destroy).toHaveBeenCalledOnce();
  });

  it("falls back to close() when destroy is refused, and lets that close through", async () => {
    windowApi.destroy.mockRejectedValue(new Error("not allowed"));
    const { update, install } = fakeUpdate();
    await installOnClose(update);
    await windowApi.handler({ preventDefault: vi.fn() });
    expect(windowApi.close).toHaveBeenCalledOnce();

    // The close() above re-enters the handler: it must not cancel it again
    // nor install a second time.
    const second = vi.fn();
    await windowApi.handler({ preventDefault: second });
    expect(second).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
  });
});

describe("restartIntoUpdate", () => {
  it("installs with the plugin default (relaunching after install) when not yet installed", async () => {
    const { update, install } = fakeUpdate();
    await restartIntoUpdate(update, false);
    expect(install).toHaveBeenCalledWith();
  });

  it("only relaunches an already-installed update", async () => {
    const { update, install } = fakeUpdate();
    await restartIntoUpdate(update, true);
    expect(install).not.toHaveBeenCalled();
  });
});
