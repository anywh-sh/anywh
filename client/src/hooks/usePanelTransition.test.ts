import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { usePanelTransition } from "@/hooks/usePanelTransition";
import { motionMediumMs } from "@/lib/motion";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MOTION = motionMediumMs();
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const setup = (open: boolean) => renderHook(({ isOpen }) => usePanelTransition(isOpen), { initialProps: { isOpen: open } });

describe("usePanelTransition", () => {
  it("is just open on mount, with nothing in motion", () => {
    expect(setup(true).result.current).toEqual({ present: true, transitioning: false });
  });

  it("is just closed on mount, not closing", () => {
    expect(setup(false).result.current).toEqual({ present: false, transitioning: false });
  });

  // The render in which the flag flips is the one that is drawn. Answering one
  // render late would unmount a closing panel's content for a frame, and a
  // fresh element has no earlier style to fade from. So every render is
  // recorded, not just the last one the effects settle on.
  it("is still present, and moving, in the very render that closes it", () => {
    const renders: { present: boolean; transitioning: boolean }[] = [];
    const { rerender } = renderHook(
      ({ isOpen }) => {
        const state = usePanelTransition(isOpen);
        renders.push(state);
        return state;
      },
      { initialProps: { isOpen: true } },
    );
    renders.length = 0;
    rerender({ isOpen: false });
    expect(renders[0]).toEqual({ present: true, transitioning: true });
  });

  it("is moving in the very render that opens it", () => {
    const { result, rerender } = setup(false);
    rerender({ isOpen: true });
    expect(result.current).toEqual({ present: true, transitioning: true });
  });

  it("lets go of the content once the closing has run out", async () => {
    const { result, rerender } = setup(true);
    rerender({ isOpen: false });
    await advance(MOTION - 1);
    expect(result.current).toEqual({ present: true, transitioning: true });
    await advance(60);
    expect(result.current).toEqual({ present: false, transitioning: false });
  });

  it("stops moving once the opening has run out, and stays present", async () => {
    const { result, rerender } = setup(false);
    rerender({ isOpen: true });
    await advance(MOTION + 60);
    expect(result.current).toEqual({ present: true, transitioning: false });
  });

  it("stays present when it is opened again in the middle of closing", async () => {
    const { result, rerender } = setup(true);
    rerender({ isOpen: false });
    await advance(MOTION / 2);
    rerender({ isOpen: true });
    await advance(MOTION * 2);
    expect(result.current).toEqual({ present: true, transitioning: false });
  });
});
