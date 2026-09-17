import { describe, expect, it } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format/relativeTime";

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
    });
  }

  it("still formats a real instant", () => {
    expect(formatRelativeTime(Date.now(), "en")).toBe("now");
    expect(formatAbsoluteTime(new Date("2026-03-15T15:30:00Z").getTime(), "en")).toContain("2026");
  });
});
