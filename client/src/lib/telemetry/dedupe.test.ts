import { beforeEach, describe, expect, it } from "vitest";
import { dailyDue, firstOpenAt, localDay, markDaily, markOnce, onceDue, swapBootVersion } from "@/lib/telemetry/dedupe";

beforeEach(() => localStorage.clear());

const MORNING = new Date(2026, 10, 8, 9, 0).getTime();
const NIGHT = new Date(2026, 10, 8, 23, 59).getTime();
const NEXT_DAY = new Date(2026, 10, 9, 0, 1).getTime();

describe("daily markers", () => {
  it("is due until marked, then not until the next local day", () => {
    expect(dailyDue("feature:sala", MORNING)).toBe(true);
    markDaily("feature:sala", MORNING);
    expect(dailyDue("feature:sala", NIGHT)).toBe(false);
    expect(dailyDue("feature:sala", NEXT_DAY)).toBe(true);
  });

  it("keeps one key's mark from silencing another", () => {
    markDaily("feature:sala", MORNING);
    expect(dailyDue("feature:terminal", MORNING)).toBe(true);
  });

  it("names the day the way the user lives it", () => {
    expect(localDay(new Date(2026, 0, 5, 12).getTime())).toBe("2026-01-05");
  });
});

describe("once markers", () => {
  it("fires once per installation", () => {
    expect(onceDue("first_prompt_sent")).toBe(true);
    markOnce("first_prompt_sent");
    expect(onceDue("first_prompt_sent")).toBe(false);
  });
});

describe("storage that cannot be trusted", () => {
  it("treats a corrupted blob as no marks", () => {
    localStorage.setItem("anywh:telemetry-marks", "{not json");
    expect(dailyDue("x", MORNING)).toBe(true);
    expect(onceDue("y")).toBe(true);
  });
});

describe("first open and boot version", () => {
  it("remembers the first open and never moves it", () => {
    expect(firstOpenAt(1000)).toBe(1000);
    expect(firstOpenAt(9000)).toBe(1000);
  });

  it("returns the previous boot's version, undefined the first time", () => {
    expect(swapBootVersion("0.1.7")).toBeUndefined();
    expect(swapBootVersion("0.1.7")).toBe("0.1.7");
    expect(swapBootVersion("0.1.8")).toBe("0.1.7");
    expect(swapBootVersion("0.1.8")).toBe("0.1.8");
  });
});
