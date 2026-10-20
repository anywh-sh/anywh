import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatCompactTime, formatRelativeTime } from "@/lib/format/relativeTime";

/**
 * Both formatters run during render, on values that come off the wire. `Intl`
 * throws `RangeError` on anything that isn't a real instant, and a throw
 * during render unmounts the entire app — so a relay that omits a timestamp
 * has to degrade to a dash, never to a blank window.
 */
describe("time formatters, against a value that is not an instant", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
    it(`does not throw for ${String(bad)}`, () => {
      expect(formatRelativeTime(bad, "en")).toBe("—");
      expect(formatAbsoluteTime(bad, "en")).toBe("—");
      expect(formatCompactTime(bad, "en")).toBe("—");
    });
  }

  it("still formats a real instant", () => {
    expect(formatRelativeTime(Date.now(), "en")).toBe("now");
    expect(formatAbsoluteTime(new Date("2026-03-15T15:30:00Z").getTime(), "en")).toContain("2026");
  });
});

describe("formatCompactTime", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("says each magnitude in as few characters as the locale allows", () => {
    const now = Date.now();
    expect(formatCompactTime(now, "en")).toBe("now");
    expect(formatCompactTime(now - 4 * MINUTE, "en")).toBe("4m");
    expect(formatCompactTime(now - 2 * HOUR, "en")).toBe("2h");
    expect(formatCompactTime(now - 5 * DAY, "en")).toBe("5d");
  });

  it("falls back to a bare month and day after a week, never a full timestamp", () => {
    const text = formatCompactTime(Date.now() - 30 * DAY, "en");
    expect(text).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
