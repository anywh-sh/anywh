import { describe, expect, it } from "vitest";
import { clampGroupResizeDelta, MIN_GROUP_PX } from "@/hooks/tabs/useGroupSizeDrag";

describe("clampGroupResizeDelta", () => {
  it("passes a small, in-bounds delta straight through", () => {
    expect(clampGroupResizeDelta(0.05, 0.5, 0.5, 0.1)).toBeCloseTo(0.05);
  });

  it("clamps at the floor when the pointer drags well past it", () => {
    // minFraction 0.1, startSizeA 0.5: the most A can shrink is to 0.1 (delta -0.4).
    expect(clampGroupResizeDelta(-0.9, 0.5, 0.5, 0.1)).toBeCloseTo(-0.4);
    // Symmetric the other way — B is the one bottoming out.
    expect(clampGroupResizeDelta(0.9, 0.5, 0.5, 0.1)).toBeCloseTo(0.4);
  });

  // Regression: reported live as "resize handle doesn't respond to
  // dragging" — an ordinary window splitting 2 groups makes MIN_GROUP_PX
  // (900px) more than half of a 50/50 pair. The bounds used to invert there
  // (low > high) and every pointermove resolved to the same forced delta.
  it("still tracks the pointer's direction when MIN_GROUP_PX exceeds half the pair's width", () => {
    const containerWidth = 1200; // MIN_GROUP_PX / 1200 = 0.75 > 0.5
    const minFraction = MIN_GROUP_PX / containerWidth;
    expect(minFraction * 2).toBeGreaterThan(1); // infeasible for a 50/50 pair (total 1)

    const draggingRight = clampGroupResizeDelta(0.05, 0.5, 0.5, minFraction);
    const draggingLeft = clampGroupResizeDelta(-0.05, 0.5, 0.5, minFraction);

    // The whole bug: both used to resolve to the identical forced delta.
    expect(draggingRight).not.toBeCloseTo(draggingLeft);
    expect(draggingRight).toBeGreaterThan(0);
    expect(draggingLeft).toBeLessThan(0);
  });

  it("caps the floor at a quarter of the pair, so an oversized floor still leaves room to drag", () => {
    expect(clampGroupResizeDelta(0.2, 0.5, 0.5, 5 /* absurdly oversized minFraction */)).toBeCloseTo(0.2);
    // A can shrink to 0.25 of the pair and no further.
    expect(clampGroupResizeDelta(-0.9, 0.5, 0.5, 5)).toBeCloseTo(-0.25);
    expect(clampGroupResizeDelta(0.9, 0.5, 0.5, 5)).toBeCloseTo(0.25);
  });

  // Regression: with the sidebar open the handle moved freely, and with it
  // closed it hit a wall. The floor was MIN_GROUP_PX where that fit the pair and
  // a tiny one where it did not, so the same pair had a far smaller range in
  // the wider container. The range must not depend on the container's width.
  it("gives the same range for the same pair in a narrow and in a wide container", () => {
    const narrow = MIN_GROUP_PX / 1200;
    const wide = MIN_GROUP_PX / 1800;
    for (const minFraction of [narrow, wide]) {
      expect(clampGroupResizeDelta(-0.9, 0.5, 0.5, minFraction)).toBeLessThanOrEqual(-0.25 + 1e-9);
      expect(clampGroupResizeDelta(0.9, 0.5, 0.5, minFraction)).toBeGreaterThanOrEqual(0.25 - 1e-9);
    }
  });

  it("never lets a group reach zero, whatever the floor", () => {
    expect(0.5 + clampGroupResizeDelta(-0.9, 0.5, 0.5, 5)).toBeGreaterThan(0);
    expect(0.5 + clampGroupResizeDelta(-0.9, 0.5, 0.5, 0)).toBeGreaterThanOrEqual(0);
  });

  // Regression: a group already under the floor used to be thrown up to it on
  // the first pointermove, as if the handle's position were there, before it
  // began to follow the pointer.
  it("does not push a group that starts under the floor up to it", () => {
    // A is 0.2, under the floor of 0.25 of the pair; B is 0.8.
    expect(clampGroupResizeDelta(0.01, 0.2, 0.8, 0.4)).toBeCloseTo(0.01);
    expect(clampGroupResizeDelta(0, 0.2, 0.8, 0.4)).toBeCloseTo(0);
    // It can still not get any smaller than it is.
    expect(clampGroupResizeDelta(-0.1, 0.2, 0.8, 0.4)).toBeCloseTo(0);
    // And the neighbour still stops at the floor.
    expect(clampGroupResizeDelta(0.9, 0.2, 0.8, 0.4)).toBeCloseTo(0.55);
  });
});
