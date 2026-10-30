import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPACT_STATUS_BAR_QUERY, useIsCompactStatusBar, useMediaQuery } from "./useMediaQuery";

/** A `matchMedia` driven by a width the test sets, for `max-width` queries
 * only — enough to prove the hook follows the window, without depending on
 * how far happy-dom's own media query support goes. */
function stubViewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  const matches = (query: string): boolean => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return max ? width <= Number(max[1]) : false;
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return matches(query);
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })),
  );
  return {
    resize(next: number) {
      width = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("answers on the first render and follows the window", () => {
    const viewport = stubViewport(1440);
    const { result } = renderHook(() => useIsCompactStatusBar());
    expect(result.current).toBe(false);

    act(() => viewport.resize(1023));
    expect(result.current).toBe(true);

    act(() => viewport.resize(1024));
    expect(result.current).toBe(false);
  });

  it("is compact from the first frame on a narrow window", () => {
    stubViewport(800);
    const { result } = renderHook(() => useMediaQuery(COMPACT_STATUS_BAR_QUERY));
    expect(result.current).toBe(true);
  });

  it("stops listening on unmount", () => {
    const viewport = stubViewport(1440);
    const { unmount } = renderHook(() => useIsCompactStatusBar());
    expect(viewport.listenerCount()).toBe(1);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });

  it("matches nothing without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useIsCompactStatusBar());
    expect(result.current).toBe(false);
  });
});
