import { describe, expect, it } from "vitest";
import {
  SALA_SIDE_DEFAULT_WIDTH,
  SALA_SIDE_MAX_WIDTH,
  SALA_SIDE_MIN_WIDTH,
  clampSalaSideWidth,
  parseSalaSideWidth,
  salaSideMaxWidth,
} from "./useSalaSideWidth";

describe("salaSideMaxWidth", () => {
  it("is half the window while that stays under the hard cap", () => {
    expect(salaSideMaxWidth(1000)).toBe(500);
  });

  it("is the hard cap in a wide window", () => {
    expect(salaSideMaxWidth(2560)).toBe(SALA_SIDE_MAX_WIDTH);
  });

  it("never drops below the minimum, however narrow the window", () => {
    expect(salaSideMaxWidth(600)).toBe(SALA_SIDE_MIN_WIDTH);
  });
});

describe("clampSalaSideWidth", () => {
  it("keeps the default as the floor", () => {
    expect(SALA_SIDE_MIN_WIDTH).toBe(SALA_SIDE_DEFAULT_WIDTH);
    expect(clampSalaSideWidth(200, 1440)).toBe(SALA_SIDE_MIN_WIDTH);
  });

  it("caps at the smaller of the hard cap and half the window", () => {
    expect(clampSalaSideWidth(900, 1440)).toBe(640);
    expect(clampSalaSideWidth(900, 1000)).toBe(500);
  });

  it("passes a width inside the limits through, rounded", () => {
    expect(clampSalaSideWidth(450.6, 1440)).toBe(451);
  });

  it("falls back to the default for a width that is not a number", () => {
    expect(clampSalaSideWidth(Number.NaN, 1440)).toBe(SALA_SIDE_DEFAULT_WIDTH);
  });
});

describe("parseSalaSideWidth", () => {
  it("reads a stored width", () => {
    expect(parseSalaSideWidth("512")).toBe(512);
  });

  it("falls back to the default for nothing, blanks and garbage", () => {
    expect(parseSalaSideWidth(null)).toBe(SALA_SIDE_DEFAULT_WIDTH);
    expect(parseSalaSideWidth("")).toBe(SALA_SIDE_DEFAULT_WIDTH);
    expect(parseSalaSideWidth("wide")).toBe(SALA_SIDE_DEFAULT_WIDTH);
    expect(parseSalaSideWidth("Infinity")).toBe(SALA_SIDE_DEFAULT_WIDTH);
  });

  it("clamps a stored width to the hard limits", () => {
    expect(parseSalaSideWidth("10")).toBe(SALA_SIDE_MIN_WIDTH);
    expect(parseSalaSideWidth("5000")).toBe(SALA_SIDE_MAX_WIDTH);
  });
});
