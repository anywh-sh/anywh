import { describe, expect, it } from "vitest";
import { contrastRatio, luminance, mix, readableInkOn, shade, tint, toCss, type Rgba } from "@/lib/color";

// `parseColor` isn't covered here: it round-trips through `getComputedStyle`
// on a probe element, which happy-dom (this tier's DOM) never computes for
// `color` — see the note on `themeApply.ts` in the repo's CLAUDE.md. Any
// assertion on it in this environment would be testing the fallback path,
// not the function.

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

describe("toCss", () => {
  it("renders an opaque color without an alpha segment", () => {
    expect(toCss({ r: 10, g: 20, b: 30, a: 1 })).toBe("rgb(10 20 30)");
  });

  it("renders a translucent color with a 3-decimal alpha segment", () => {
    expect(toCss({ r: 10, g: 20, b: 30, a: 0.5 })).toBe("rgb(10 20 30 / 0.500)");
  });

  it("rounds fractional channel values", () => {
    expect(toCss({ r: 10.4, g: 10.5, b: 10.6, a: 1 })).toBe("rgb(10 11 11)");
  });

  it("clamps channels outside 0–255", () => {
    expect(toCss({ r: -10, g: 300, b: 128, a: 1 })).toBe("rgb(0 255 128)");
  });
});

describe("mix", () => {
  it("returns the first color at ratio 0", () => {
    expect(mix(BLACK, WHITE, 0)).toEqual(BLACK);
  });

  it("returns the second color at ratio 1", () => {
    expect(mix(BLACK, WHITE, 1)).toEqual(WHITE);
  });

  it("splits evenly at ratio 0.5", () => {
    expect(mix(BLACK, WHITE, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });

  it("carries alpha along with the mix", () => {
    const a: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    const b: Rgba = { r: 0, g: 0, b: 0, a: 1 };
    expect(mix(a, b, 0.25).a).toBeCloseTo(0.25);
  });

  it("clamps a ratio below 0 to 0", () => {
    expect(mix(BLACK, WHITE, -1)).toEqual(BLACK);
  });

  it("clamps a ratio above 1 to 1", () => {
    expect(mix(BLACK, WHITE, 2)).toEqual(WHITE);
  });
});

describe("shade and tint", () => {
  it("shade at 0% leaves the color unchanged", () => {
    expect(shade(WHITE, 0)).toEqual(WHITE);
  });

  it("shade at 100% reaches black", () => {
    expect(shade(WHITE, 100)).toEqual(BLACK);
  });

  it("tint at 0% leaves the color unchanged", () => {
    expect(tint(BLACK, 0)).toEqual(BLACK);
  });

  it("tint at 100% reaches white", () => {
    expect(tint(BLACK, 100)).toEqual(WHITE);
  });

  it("shade moves toward black by the given percent", () => {
    expect(shade({ r: 200, g: 200, b: 200, a: 1 }, 50)).toEqual({ r: 100, g: 100, b: 100, a: 1 });
  });

  it("tint moves toward white by the given percent", () => {
    expect(tint({ r: 100, g: 100, b: 100, a: 1 }, 50)).toEqual({ r: 177.5, g: 177.5, b: 177.5, a: 1 });
  });
});

describe("luminance", () => {
  it("is 0 for black", () => {
    expect(luminance(BLACK)).toBe(0);
  });

  it("is 255 for white", () => {
    expect(luminance(WHITE)).toBe(255);
  });

  it("weighs green the heaviest and blue the lightest (BT.601)", () => {
    expect(luminance({ r: 255, g: 0, b: 0, a: 1 })).toBeCloseTo(76.245);
    expect(luminance({ r: 0, g: 255, b: 0, a: 1 })).toBeCloseTo(149.685);
    expect(luminance({ r: 0, g: 0, b: 255, a: 1 })).toBeCloseTo(29.07);
  });
});

describe("contrastRatio", () => {
  it("is 21 (the maximum) between black and white", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21);
  });

  it("is 1 (the minimum) between a color and itself", () => {
    expect(contrastRatio({ r: 120, g: 60, b: 200, a: 1 }, { r: 120, g: 60, b: 200, a: 1 })).toBeCloseTo(1);
  });

  it("is symmetric in its two arguments", () => {
    const a: Rgba = { r: 224, g: 100, b: 42, a: 1 };
    const b: Rgba = { r: 236, g: 234, b: 228, a: 1 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a));
  });

  it("matches the WCAG floor cited for a mid-tone accent on cream", () => {
    // Same pair the color.ts doc comment uses to justify readableInkOn.
    expect(contrastRatio({ r: 224, g: 100, b: 42, a: 1 }, { r: 236, g: 234, b: 228, a: 1 })).toBeCloseTo(2.9, 1);
  });
});

describe("readableInkOn", () => {
  it("picks the background when the fill contrasts more with it than with the foreground", () => {
    const fill: Rgba = { r: 40, g: 40, b: 40, a: 1 };
    expect(readableInkOn(fill, WHITE, BLACK)).toEqual(WHITE);
  });

  it("picks the foreground when the fill contrasts more with it than with the background", () => {
    const fill: Rgba = { r: 220, g: 220, b: 220, a: 1 };
    expect(readableInkOn(fill, WHITE, BLACK)).toEqual(BLACK);
  });

  it("prefers the background on an exact tie", () => {
    expect(readableInkOn(WHITE, WHITE, WHITE)).toEqual(WHITE);
  });
});
