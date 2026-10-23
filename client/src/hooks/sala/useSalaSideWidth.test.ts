import { describe, expect, it } from "vitest";
import {
  SALA_SIDE_DEFAULT_WIDTH,
  SALA_SIDE_MIN_WIDTH,
  clampSalaSideWidth,
  parseSalaSideWidth,
  salaSideChatWidth,
  salaSideMaxWidth,
} from "./useSalaSideWidth";

describe("salaSideChatWidth", () => {
  it("is the conversation's widest text column plus its padding, gutters and the divider", () => {
    // MessageLog: 680px of text, px-4 on each side, an 8px gutter on each edge.
    expect(salaSideChatWidth(1)).toBe(680 + 32 + 16 + 1);
  });

  it("grows with the font size setting, as the text column does", () => {
    expect(salaSideChatWidth(20 / 15)).toBe(Math.round((680 * 20) / 15) + 49);
  });
});

describe("salaSideMaxWidth", () => {
  it("is what a conversation can use in a wide window", () => {
    expect(salaSideMaxWidth(2560)).toBe(729);
  });

  it("is half the window when that is narrower", () => {
    expect(salaSideMaxWidth(1200)).toBe(600);
  });

  it("never drops below the minimum, however narrow the window", () => {
    expect(salaSideMaxWidth(600)).toBe(SALA_SIDE_MIN_WIDTH);
  });
});

describe("clampSalaSideWidth", () => {
  it("keeps the default as the floor", () => {
    expect(SALA_SIDE_MIN_WIDTH).toBe(SALA_SIDE_DEFAULT_WIDTH);
    expect(clampSalaSideWidth(200, 729)).toBe(SALA_SIDE_MIN_WIDTH);
  });

  it("caps at the maximum it is given", () => {
    expect(clampSalaSideWidth(900, 729)).toBe(729);
    expect(clampSalaSideWidth(900, 500)).toBe(500);
  });

  it("passes a width inside the limits through, rounded", () => {
    expect(clampSalaSideWidth(450.6, 729)).toBe(451);
  });

  it("falls back to the default for a width that is not a number", () => {
    expect(clampSalaSideWidth(Number.NaN, 729)).toBe(SALA_SIDE_DEFAULT_WIDTH);
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

  it("raises a stored width below the minimum", () => {
    expect(parseSalaSideWidth("10")).toBe(SALA_SIDE_MIN_WIDTH);
  });
});
