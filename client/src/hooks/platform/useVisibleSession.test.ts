import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { setVisibleSessionMock, isIOSMock } = vi.hoisted(() => ({
  setVisibleSessionMock: vi.fn((_id: string | null) => Promise.resolve()),
  isIOSMock: vi.fn(() => true),
}));
vi.mock("@/lib/platform/nativePush", () => ({ setVisibleSession: setVisibleSessionMock }));
vi.mock("@/lib/platform/platform", () => ({ isIOS: isIOSMock }));

import { useVisibleSession } from "./useVisibleSession";

beforeEach(() => {
  setVisibleSessionMock.mockClear();
  isIOSMock.mockReturnValue(true);
});

describe("useVisibleSession", () => {
  it("reports the active session while the app is in the foreground, and none when it is not", () => {
    const initial: { id: string | null; focused: boolean } = { id: "s1", focused: true };
    const { rerender } = renderHook(({ id, focused }) => useVisibleSession(id, focused), { initialProps: initial });
    expect(setVisibleSessionMock).toHaveBeenLastCalledWith("s1");

    rerender({ id: "s1", focused: false });
    expect(setVisibleSessionMock).toHaveBeenLastCalledWith(null);

    rerender({ id: "s2", focused: true });
    expect(setVisibleSessionMock).toHaveBeenLastCalledWith("s2");
  });

  it("reports nothing visible when no conversation is open, and clears on unmount", () => {
    const { unmount } = renderHook(() => useVisibleSession(null, true));
    expect(setVisibleSessionMock).toHaveBeenLastCalledWith(null);
    setVisibleSessionMock.mockClear();
    unmount();
    expect(setVisibleSessionMock).toHaveBeenCalledWith(null);
  });

  it("does not repeat itself while nothing changed", () => {
    const { rerender } = renderHook(({ id }) => useVisibleSession(id, true), { initialProps: { id: "s1" } });
    rerender({ id: "s1" });
    expect(setVisibleSessionMock).toHaveBeenCalledTimes(1);
  });

  it("is inert off iOS", () => {
    isIOSMock.mockReturnValue(false);
    const { unmount } = renderHook(() => useVisibleSession("s1", true));
    unmount();
    expect(setVisibleSessionMock).not.toHaveBeenCalled();
  });
});
