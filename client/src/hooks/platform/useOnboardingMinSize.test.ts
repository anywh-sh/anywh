import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforcesMinSize, useOnboardingMinSize, type MinSizeWindow } from "./useOnboardingMinSize";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeWindow(fail = false) {
  const calls: Array<{ width: number; height: number } | null> = [];
  const win: MinSizeWindow = {
    setMinSize: (size) => {
      calls.push(size);
      return fail ? Promise.reject(new Error("not allowed")) : Promise.resolve();
    },
  };
  return { calls, getWindow: () => Promise.resolve(win) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("enforcesMinSize", () => {
  it("only on a desktop window inside Tauri", () => {
    expect(enforcesMinSize(true, "linux")).toBe(true);
    expect(enforcesMinSize(true, "macos")).toBe(true);
    expect(enforcesMinSize(true, "windows")).toBe(true);
    expect(enforcesMinSize(true, "ios")).toBe(false);
    expect(enforcesMinSize(false, null)).toBe(false);
  });
});

describe("useOnboardingMinSize", () => {
  it("sets 480×520 while mounted and lifts it on unmount", async () => {
    const { calls, getWindow } = fakeWindow();
    const { unmount } = renderHook(() => useOnboardingMinSize(getWindow, true));
    await flush();
    expect(calls).toEqual([{ width: 480, height: 520 }]);
    unmount();
    await flush();
    expect(calls).toEqual([{ width: 480, height: 520 }, null]);
  });

  it("does nothing outside a desktop window — no call at all", async () => {
    const getWindow = vi.fn(fakeWindow().getWindow);
    const { unmount } = renderHook(() => useOnboardingMinSize(getWindow, false));
    unmount();
    await flush();
    expect(getWindow).not.toHaveBeenCalled();
  });

  it("a refused call is only a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getWindow } = fakeWindow(true);
    const { unmount } = renderHook(() => useOnboardingMinSize(getWindow, true));
    await flush();
    unmount();
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
