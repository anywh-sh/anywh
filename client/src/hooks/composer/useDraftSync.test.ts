import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftSync } from "./useDraftSync";

describe("useDraftSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the text once the debounce window passes", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDraftSync(onChange));
    act(() => result.current.schedule("hello"));
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(400));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("hello");
  });

  it("coalesces rapid edits into the last one", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDraftSync(onChange));
    act(() => result.current.schedule("h"));
    act(() => void vi.advanceTimersByTime(300));
    act(() => result.current.schedule("he"));
    act(() => void vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(100));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("he");
  });

  it("flushes immediately and cancels the pending debounce", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDraftSync(onChange));
    act(() => result.current.schedule("draft"));
    act(() => result.current.flush(""));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
    act(() => void vi.advanceTimersByTime(1000));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops a pending call on unmount", () => {
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() => useDraftSync(onChange));
    act(() => result.current.schedule("draft"));
    unmount();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls the latest onChange, not the one from when it was scheduled", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useDraftSync(cb), { initialProps: { cb: first } });
    act(() => result.current.schedule("x"));
    rerender({ cb: second });
    act(() => void vi.advanceTimersByTime(400));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("x");
  });
});
