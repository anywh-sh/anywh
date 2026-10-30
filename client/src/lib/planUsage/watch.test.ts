import { describe, expect, it } from "vitest";

import { parseStateMessage } from "@/lib/planUsage/watch";

describe("parseStateMessage", () => {
  it("reads a plan_usage_state", () => {
    const raw = JSON.stringify({
      type: "plan_usage_state",
      observedAt: 1000,
      runtimes: [{ runtime: "claude", status: "ok", windows: [{ durationMins: 300, usedPercent: 12, resetsAt: 5000 }], observedAt: 900 }],
    });
    expect(parseStateMessage(raw)).toEqual({
      observedAt: 1000,
      runtimes: [{ runtime: "claude", status: "ok", windows: [{ durationMins: 300, usedPercent: 12, resetsAt: 5000 }], observedAt: 900 }],
    });
  });

  it("drops entries and windows that don't have the shape", () => {
    const raw = JSON.stringify({
      type: "plan_usage_state",
      observedAt: 1000,
      runtimes: [
        { runtime: "claude", status: "ok", windows: [{ durationMins: "300", usedPercent: 12, resetsAt: 5000 }, { durationMins: 10080, usedPercent: 3, resetsAt: null }] },
        { runtime: "codex", windows: [] },
        null,
      ],
    });
    expect(parseStateMessage(raw)?.runtimes).toEqual([
      { runtime: "claude", status: "ok", windows: [{ durationMins: 10080, usedPercent: 3, resetsAt: null }], observedAt: null },
    ]);
  });

  it("is not a state for anything else", () => {
    expect(parseStateMessage("not json")).toBeNull();
    expect(parseStateMessage(JSON.stringify({ type: "protocol_version", version: 1 }))).toBeNull();
    expect(parseStateMessage(JSON.stringify({ type: "plan_usage_state", runtimes: "x" }))).toBeNull();
  });
});
