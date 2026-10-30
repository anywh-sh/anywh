import { describe, expect, it } from "vitest";

import {
  clampPercent,
  dailyCuts,
  effectivePercent,
  expectedPace,
  isWindowExpired,
  showsPaceMark,
  usageLevel,
  windowLabel,
} from "@/lib/planUsage/meter";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MIN = 60_000;

describe("clampPercent", () => {
  it("rounds into 0..100 and reads garbage as nothing used", () => {
    expect(clampPercent(57.6)).toBe(58);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("usageLevel", () => {
  it("is neutral under 80, warn from 80 to 99, limited at 100", () => {
    expect(usageLevel(0)).toBe("neutral");
    expect(usageLevel(79)).toBe("neutral");
    expect(usageLevel(79.4)).toBe("neutral");
    expect(usageLevel(79.5)).toBe("warn");
    expect(usageLevel(80)).toBe("warn");
    expect(usageLevel(99)).toBe("warn");
    expect(usageLevel(100)).toBe("limited");
    expect(usageLevel(120)).toBe("limited");
  });

  it("lets the agent's own warning raise a window to warn, never past it", () => {
    expect(usageLevel(40, { warning: true })).toBe("warn");
    expect(usageLevel(100, { warning: true })).toBe("limited");
    expect(usageLevel(40, { warning: false })).toBe("neutral");
  });
});

describe("expired windows", () => {
  it("treats a reset time at or before now as expired", () => {
    expect(isWindowExpired(NOW - 1, NOW)).toBe(true);
    expect(isWindowExpired(NOW, NOW)).toBe(true);
    expect(isWindowExpired(NOW + 1, NOW)).toBe(false);
    expect(isWindowExpired(Number.NaN, NOW)).toBe(false);
  });

  it("shows 0% for an expired window instead of the old reading", () => {
    expect(effectivePercent(100, NOW - MIN, NOW)).toBe(0);
    expect(effectivePercent(58.2, NOW + MIN, NOW)).toBe(58);
  });
});

describe("expectedPace", () => {
  it("is the share of the window's time already gone", () => {
    // 5h window resetting in 2h: 3h of 5h gone.
    expect(expectedPace(300, NOW + 120 * MIN, NOW)).toBe(60);
    expect(expectedPace(300, NOW + 300 * MIN, NOW)).toBe(0);
    expect(expectedPace(300, NOW, NOW)).toBe(100);
    // 7d window resetting in 3.5 days.
    expect(expectedPace(10080, NOW + 5040 * MIN, NOW)).toBe(50);
  });

  it("caps at 100 once the reset is behind", () => {
    expect(expectedPace(300, NOW - 10 * MIN, NOW)).toBe(100);
  });

  it("has no answer when the numbers don't add up", () => {
    expect(expectedPace(0, NOW + MIN, NOW)).toBeNull();
    expect(expectedPace(Number.NaN, NOW + MIN, NOW)).toBeNull();
    expect(expectedPace(300, Number.NaN, NOW)).toBeNull();
    // Resets further away than the window is long.
    expect(expectedPace(300, NOW + 301 * MIN, NOW)).toBeNull();
  });
});

describe("showsPaceMark", () => {
  it("drops the mark only when the window is spent", () => {
    expect(showsPaceMark(0)).toBe(true);
    expect(showsPaceMark(99)).toBe(true);
    expect(showsPaceMark(100)).toBe(false);
  });
});

describe("dailyCuts", () => {
  it("splits the weekly window into seven days with six cuts", () => {
    const cuts = dailyCuts(10080);
    expect(cuts).toHaveLength(6);
    expect(cuts[0]).toBeCloseTo(100 / 7);
    expect(cuts[5]).toBeCloseTo(600 / 7);
    expect(dailyCuts(10079)).toHaveLength(6);
  });

  it("leaves every other window uncut", () => {
    expect(dailyCuts(300)).toEqual([]);
    expect(dailyCuts(43200)).toEqual([]);
    expect(dailyCuts(10082)).toEqual([]);
  });
});

describe("windowLabel", () => {
  it("names the known windows", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(43200)).toBe("30d");
    expect(windowLabel(44640)).toBe("30d");
  });

  it("falls back to the largest whole unit", () => {
    expect(windowLabel(1440)).toBe("1d");
    expect(windowLabel(120)).toBe("2h");
    expect(windowLabel(90)).toBe("90m");
  });
});
