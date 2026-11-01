import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useDockPresence } from "@/hooks/useDockPresence";
import { motionMediumMs } from "@/lib/motion";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MOTION = motionMediumMs();
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("useDockPresence", () => {
  it("is there when it starts open — nothing animates on load", () => {
    const { result } = renderHook(() => useDockPresence(true));
    expect(result.current).toBe(true);
  });

  it("is not there when it starts closed", () => {
    const { result } = renderHook(() => useDockPresence(false));
    expect(result.current).toBe(false);
  });

  it("is there the moment it opens", () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: false } });
    rerender({ open: true });
    expect(result.current).toBe(true);
  });

  // Closing: it stays long enough for its width and its fade to run out.
  it("stays on screen while it closes and lets go once the transition is over", async () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toBe(true);

    await advance(MOTION - 1);
    expect(result.current).toBe(true);
    await advance(60);
    expect(result.current).toBe(false);
  });

  it("stays when it is opened again before it has finished closing", async () => {
    const { result, rerender } = renderHook(({ open }) => useDockPresence(open), { initialProps: { open: true } });
    rerender({ open: false });
    await advance(MOTION / 2);
    rerender({ open: true });
    await advance(MOTION * 2);

    expect(result.current).toBe(true);
  });
});
