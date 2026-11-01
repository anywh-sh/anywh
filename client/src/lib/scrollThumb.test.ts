import { describe, expect, it } from "vitest";
import { scrollLeftForThumb, scrollThumb } from "@/lib/scrollThumb";

describe("scrollThumb", () => {
  it("draws nothing when the content fits", () => {
    expect(scrollThumb(0, 500, 500)).toBeNull();
    expect(scrollThumb(0, 400, 500)).toBeNull();
    expect(scrollThumb(0, 500, 0)).toBeNull();
  });

  it("sizes the thumb by the share of the content in view", () => {
    expect(scrollThumb(0, 1000, 500)).toEqual({ left: 0, width: 250 });
  });

  it("puts the thumb flush with each end of the track at the ends of the scroll", () => {
    expect(scrollThumb(0, 1000, 500)?.left).toBe(0);
    const end = scrollThumb(500, 1000, 500);
    expect(end).toEqual({ left: 250, width: 250 });
  });

  it("keeps a thumb that can still be seen and grabbed with very many tabs", () => {
    expect(scrollThumb(0, 100000, 500)?.width).toBe(24);
  });

  it("clamps an overscrolled position", () => {
    expect(scrollThumb(-40, 1000, 500)?.left).toBe(0);
    expect(scrollThumb(900, 1000, 500)?.left).toBe(250);
  });
});

describe("scrollLeftForThumb", () => {
  it("inverts scrollThumb", () => {
    const thumb = scrollThumb(300, 1000, 500);
    expect(scrollLeftForThumb(thumb?.left ?? 0, 1000, 500)).toBeCloseTo(300);
  });

  it("clamps a drag past either end of the track", () => {
    expect(scrollLeftForThumb(-50, 1000, 500)).toBe(0);
    expect(scrollLeftForThumb(9999, 1000, 500)).toBe(500);
  });

  it("is 0 when there is nothing to scroll", () => {
    expect(scrollLeftForThumb(10, 400, 500)).toBe(0);
  });
});
