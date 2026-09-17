import { describe, expect, it } from "vitest";
import { countDiffLines, relativeToCwd } from "./toolCallSummary";

describe("relativeToCwd", () => {
  it("drops the working directory from an absolute path", () => {
    expect(relativeToCwd("/home/wil/app/src/main.ts", "/home/wil/app")).toBe("src/main.ts");
  });

  it("tolerates a trailing separator on the working directory", () => {
    expect(relativeToCwd("/home/wil/app/src/main.ts", "/home/wil/app/")).toBe("src/main.ts");
  });

  it("handles the backslashes a Windows relay reports", () => {
    expect(relativeToCwd("C:\\src\\app\\index.ts", "C:\\src\\app")).toBe("index.ts");
  });

  // A prefix match on the string alone would turn `/home/wil/app-old/x.ts`
  // into `old/x.ts` — a path that reads like it exists and doesn't.
  it("does not trim a sibling directory that merely shares the prefix", () => {
    expect(relativeToCwd("/home/wil/app-old/x.ts", "/home/wil/app")).toBe("/home/wil/app-old/x.ts");
  });

  it("leaves a path outside the working directory alone", () => {
    expect(relativeToCwd("/etc/hosts", "/home/wil/app")).toBe("/etc/hosts");
  });

  it("leaves everything alone when the working directory isn't known yet", () => {
    expect(relativeToCwd("/home/wil/app/src/main.ts", null)).toBe("/home/wil/app/src/main.ts");
  });
});

describe("countDiffLines", () => {
  it("counts the patch's own markers", () => {
    const counts = countDiffLines([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" keep", "-gone", "+new", "+also new"] },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ["-out", "+in"] },
    ]);

    expect(counts).toEqual({ added: 3, removed: 2 });
  });

  // The patch format prefixes every context line with a space, so source
  // that itself starts with `+` or `-` arrives as `" +x"` and must not count.
  it("ignores context lines whose own text starts with a marker", () => {
    const counts = countDiffLines([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" +not a diff marker", " -neither is this"] },
    ]);

    expect(counts).toEqual({ added: 0, removed: 0 });
  });

  it("reports zero for an empty patch", () => {
    expect(countDiffLines([])).toEqual({ added: 0, removed: 0 });
  });
});
