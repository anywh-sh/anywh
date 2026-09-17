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
  // dragging" — an ordinary browser window (1200-1600px) splitting 2 groups
  // makes MIN_GROUP_PX (900px) amount to more than half of a 50/50 pair
  // (minFraction 0.75 > 0.5, so 2x it exceeds the pair's total of 1). Before
  // the fix, clampGroupResizeDelta's two bounds inverted (low > high), and
  // Math.max/Math.min always resolved to the same forced value — every
  // pointermove computed the exact same delta regardless of how far or which
  // direction the pointer actually moved.
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

  it("falls back to a small absolute floor, not a frozen midpoint, once MIN_GROUP_PX is infeasible", () => {
    // A naive "cap minFraction at half the pair" fix would still freeze the
    // drag at exactly the midpoint (low === high whenever the cap binds),
    // just at a different fixed point instead of a wrong one — still not a
    // responsive drag. The small absolute floor below leaves real room.
    const delta = clampGroupResizeDelta(0.2, 0.5, 0.5, 5 /* absurdly oversized minFraction */);
    expect(delta).toBeCloseTo(0.2);
  });

  it("still protects against a group reaching exactly zero even with an infeasible MIN_GROUP_PX", () => {
    const delta = clampGroupResizeDelta(-0.9, 0.5, 0.5, 5);
    expect(0.5 + delta).toBeGreaterThan(0);
  });
});
