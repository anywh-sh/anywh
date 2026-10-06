import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserIdle } from "./useUserIdle";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const input = (type: string) => act(() => void window.dispatchEvent(new Event(type)));

describe("useUserIdle", () => {
  it("is idle once the timeout passes with no input, and not before", () => {
    const { result } = renderHook(() => useUserIdle(120_000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(119_999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("any of the input events wakes it, and it can go idle again", () => {
    const { result } = renderHook(() => useUserIdle(120_000));
    act(() => void vi.advanceTimersByTime(120_000));
    expect(result.current).toBe(true);

    input("pointermove");
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(120_000));
    expect(result.current).toBe(true);

    for (const type of ["keydown", "wheel", "touchstart", "pointerdown"]) {
      input(type);
      expect(result.current, type).toBe(false);
      act(() => void vi.advanceTimersByTime(120_000));
      expect(result.current, type).toBe(true);
    }
  });

  it("input just before the deadline pushes the deadline back", () => {
    const { result } = renderHook(() => useUserIdle(120_000));
    act(() => void vi.advanceTimersByTime(100_000));
    input("keydown");
    act(() => void vi.advanceTimersByTime(100_000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(result.current).toBe(true);
  });

  it("when disabled it never reports idle and listens to nothing", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { result } = renderHook(() => useUserIdle(120_000, false));
    act(() => void vi.advanceTimersByTime(10 * 120_000));
    expect(result.current).toBe(false);
    expect(add).not.toHaveBeenCalledWith("pointermove", expect.anything(), expect.anything());
    add.mockRestore();
  });

  it("stops listening and timing when unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useUserIdle(120_000));
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.anything());
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});
