import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useDockPresence } from "@/hooks/useDockPresence";
import { motionFastMs } from "@/lib/motion";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MOTION = motionFastMs();
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useDockPresence", () => {
  it("is simply there when it starts open — nothing animates on load", () => {
    const { result } = renderHook(() => useDockPresence(true));
    expect(result.current).toEqual({ shown: true, visible: true });
  });

  it("is not there when it starts closed", () => {
    const { result } = renderHook(() => useDockPresence(false));
    expect(result.current).toEqual({ shown: false, visible: false });
  });

  // Opening: the space first, so there is something to slide into, then the slide.
  it("takes its space at once on opening and slides in a couple of frames later", async () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: false } });
    rerender({ open: true });
    expect(result.current).toEqual({ shown: true, visible: false });

    await advance(100);
    expect(result.current).toEqual({ shown: true, visible: true });
  });

  // Closing: the slide first, then the space — handing it back at once would
  // cut the panel off before it had moved.
  it("slides out on closing and gives the space back only once it is gone", async () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toEqual({ shown: true, visible: false });

    await advance(MOTION - 1);
    expect(result.current.shown).toBe(true);
    await advance(2);
    expect(result.current).toEqual({ shown: false, visible: false });
  });

  it("keeps its space when it is opened again before it has finished closing", async () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: true } });
    rerender({ open: false });
    await advance(MOTION / 2);
    rerender({ open: true });
    await advance(MOTION * 2);

    expect(result.current).toEqual({ shown: true, visible: true });
  });
});
