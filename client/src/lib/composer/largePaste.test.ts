import { describe, expect, it } from "vitest";
import { isLargePaste, LARGE_PASTE_MIN_CHARS, LARGE_PASTE_MIN_LINES } from "@/lib/composer/largePaste";

describe("isLargePaste", () => {
  it("stays inline just under both bounds", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_MIN_CHARS - 1))).toBe(false);
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_MIN_LINES - 1 }, () => "a").join("\n"))).toBe(false);
  });

  it("turns into an attachment at either bound", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_MIN_CHARS))).toBe(true);
    expect(isLargePaste(Array.from({ length: LARGE_PASTE_MIN_LINES }, () => "a").join("\n"))).toBe(true);
  });
});
