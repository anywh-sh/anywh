import { describe, expect, it } from "vitest";
import { nextScrollToEndVisible } from "./scrollToEndVisibility";

const at = (distanceFromEnd: number, viewportHeight = 800) => ({ distanceFromEnd, viewportHeight });

describe("nextScrollToEndVisible", () => {
  it("shows once far above the end (half a viewport)", () => {
    expect(nextScrollToEndVisible(false, at(401))).toBe(true);
  });

  it("doesn't flash for a little slack", () => {
    expect(nextScrollToEndVisible(false, at(40))).toBe(false);
    expect(nextScrollToEndVisible(false, at(400))).toBe(false);
  });

  it("keeps whatever it was in the middle zone", () => {
    expect(nextScrollToEndVisible(true, at(100))).toBe(true);
    expect(nextScrollToEndVisible(false, at(100))).toBe(false);
  });

  it("hides only on getting back to the end", () => {
    expect(nextScrollToEndVisible(true, at(5))).toBe(true);
    expect(nextScrollToEndVisible(true, at(4))).toBe(false);
    expect(nextScrollToEndVisible(true, at(0))).toBe(false);
  });

  it("uses a 240px minimum on a small viewport", () => {
    expect(nextScrollToEndVisible(false, at(239, 300))).toBe(false);
    expect(nextScrollToEndVisible(false, at(241, 300))).toBe(true);
  });
});
