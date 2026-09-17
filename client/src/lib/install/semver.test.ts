import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion } from "@/lib/install/semver";

describe("compareVersions", () => {
  it.each([
    // [a, b, expected sign]
    ["0.1.10", "0.1.9", 1], // the string-comparison trap: "0.1.10" < "0.1.9" alphabetically
    ["0.1.9", "0.1.10", -1],
    ["v0.1.8", "0.1.8", 0], // a "v" prefix on either side compares the same
    ["0.1.8", "0.1.8", 0],
    ["0.1.8-rc.1", "0.1.8", 0], // a prerelease suffix is ignored, not treated as older
    ["1.0.0", "0.99.99", 1],
    ["0.2.0", "0.1.99", 1],
  ])("compareVersions(%s, %s) has the sign of %d", (a, b, expectedSign) => {
    const result = compareVersions(a, b);
    expect(result).not.toBeNull();
    expect(Math.sign(result as number)).toBe(expectedSign);
  });

  it.each([
    ["not-a-version", "0.1.8"],
    ["0.1.8", "garbage"],
    ["0.1", "0.1.0"], // two components isn't MAJOR.MINOR.PATCH
    ["", "0.1.0"],
  ])("returns null for malformed input (%s, %s)", (a, b) => {
    expect(compareVersions(a, b)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("is true only when candidate strictly exceeds current", () => {
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.9", "0.1.10")).toBe(false);
    expect(isNewerVersion("0.1.9", "0.1.9")).toBe(false);
  });

  it("is false when either side is malformed", () => {
    expect(isNewerVersion("garbage", "0.1.9")).toBe(false);
  });
});
