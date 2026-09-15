import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useForegroundSync } from "@/hooks/useForegroundSync";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useForegroundSync", () => {
  it("runs sync on mount regardless of poll", () => {
    const sync = vi.fn();
    renderHook(() => useForegroundSync(sync, { poll: false }));

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("never arms the timer when poll is off, even well past the poll interval", () => {
    const sync = vi.fn();
    renderHook(() => useForegroundSync(sync, { poll: false }));
    sync.mockClear();

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(sync).not.toHaveBeenCalled();
  });

  it("defaults poll to on when no options are passed", () => {
    const sync = vi.fn();
    renderHook(() => useForegroundSync(sync));
    sync.mockClear();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("floors every trigger — including focus bursts — at MIN_REFRESH_MS, not just the poll", () => {
    const sync = vi.fn();
    renderHook(() => useForegroundSync(sync, { poll: true }));
    sync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    // A burst of refocus events right after mount is still inside the 60s
    // floor — none of them should re-run sync.
    expect(sync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("focus"));
    });

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("re-arms the timer when poll flips from off to on for the same sync identity", () => {
    const sync = vi.fn();
    const { rerender } = renderHook(({ poll }) => useForegroundSync(sync, { poll }), {
      initialProps: { poll: false },
    });
    sync.mockClear();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(sync).not.toHaveBeenCalled();

    rerender({ poll: true });
    // The rerender tears down the old effect and mounts a fresh one, which
    // runs its own immediate sync — clear that before asserting on the timer.
    sync.mockClear();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(sync).toHaveBeenCalledTimes(1);
  });
});
