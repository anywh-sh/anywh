import { beforeEach, describe, expect, it } from "vitest";
import { createTelemetry, type Sdk, type TelemetryDeps } from "@/lib/telemetry/client";

/** The SDK is the one boundary faked: it records what it was asked to send,
 * nothing else about the controller is replaced. */
function rig(overrides: Partial<TelemetryDeps> = {}, optedIn: boolean | null = null) {
  const sent: { event: string; properties: Record<string, unknown>; timestamp: Date }[] = [];
  let loads = 0;
  let choice = optedIn;
  let clock = new Date(2026, 10, 8, 12).getTime();
  const sdk: Sdk = { capture: (event, properties, options) => sent.push({ event, properties, timestamp: options.timestamp }) };
  const telemetry = createTelemetry({
    key: "phc_test",
    loadSdk: () => {
      loads += 1;
      return Promise.resolve(sdk);
    },
    readOptedIn: () => choice,
    writeOptedIn: (value) => {
      choice = value;
    },
    commonProps: () => Promise.resolve({ app_version: "0.1.7", os: "linux" }),
    now: () => clock,
    ...overrides,
  });
  return {
    telemetry,
    sent,
    loads: () => loads,
    choice: () => choice,
    advance: (ms: number) => {
      clock += ms;
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

beforeEach(() => localStorage.clear());

describe("GeoIP", () => {
  it("every emitted event carries $geoip_disable, including the opt-out count", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    r.telemetry.track("feature_used", { feature: "sala" });
    await r.settle();
    r.telemetry.optOut("settings");
    await r.settle();
    expect(r.sent.length).toBeGreaterThanOrEqual(2);
    for (const e of r.sent) expect(e.properties.$geoip_disable).toBe(true);
  });
});

describe("without a key", () => {
  it("is a no-op that never loads the SDK, whatever the consent", async () => {
    const r = rig({ key: undefined }, true);
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.available).toBe(false);
    expect(r.telemetry.track("app_active", {})).toBe("dropped");
    expect(r.telemetry.bannerPending()).toBe(false);
    r.telemetry.optOut("settings");
    await r.settle();
    expect(r.loads()).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it("treats an empty key (a release built without the secret) the same way", () => {
    expect(rig({ key: "" }).telemetry.available).toBe(false);
  });
});

describe("while the banner is unresolved", () => {
  it("holds events in memory and sends nothing", async () => {
    const r = rig();
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.bannerPending()).toBe(true);
    expect(r.telemetry.track("feature_used", { feature: "sala" })).toBe("buffered");
    await r.settle();
    expect(r.sent).toEqual([]);
    expect(r.loads()).toBe(0);
  });

  it("flushes them, with their original timestamps, once the user accepts", async () => {
    const r = rig();
    r.telemetry.setEnvDisabled(false);
    const at = new Date(2026, 10, 8, 12);
    r.telemetry.track("feature_used", { feature: "sala" });
    r.advance(5000);
    r.telemetry.optIn();
    await r.settle();
    expect(r.sent.map((s) => s.event)).toEqual(["feature_used"]);
    expect(r.sent[0]?.timestamp).toEqual(at);
    expect(r.sent[0]?.properties).toMatchObject({ feature: "sala", app_version: "0.1.7", $process_person_profile: false });
  });

  it("still sends first_prompt_sent after a quit before the banner was answered", async () => {
    const first = rig();
    first.telemetry.setEnvDisabled(false);
    expect(first.telemetry.trackOnce("first_prompt_sent", "first_prompt_sent", { seconds_since_first_open: 10, runtime: "claude" })).toBe("buffered");
    // Quit: the in-memory buffer is gone, the next launch starts from storage.
    const second = rig();
    second.telemetry.setEnvDisabled(false);
    expect(second.telemetry.trackOnce("first_prompt_sent", "first_prompt_sent", { seconds_since_first_open: 20, runtime: "claude" })).toBe("buffered");
    second.telemetry.optIn();
    await second.settle();
    expect(second.sent.map((s) => s.event)).toEqual(["first_prompt_sent"]);
    // Once it went out, it is spent.
    expect(second.telemetry.trackOnce("first_prompt_sent", "first_prompt_sent", { seconds_since_first_open: 30, runtime: "claude" })).toBe("dropped");
  });

  it("does not burn a daily marker while the event is only held", async () => {
    const first = rig();
    first.telemetry.setEnvDisabled(false);
    expect(first.telemetry.trackDaily("app_active", "app_active", {})).toBe("buffered");
    expect(first.telemetry.trackDaily("app_active", "app_active", {})).toBe("dropped");
    const second = rig();
    second.telemetry.setEnvDisabled(false);
    second.telemetry.optIn();
    expect(second.telemetry.trackDaily("app_active", "app_active", {})).toBe("sent");
    await second.settle();
    expect(second.sent.map((s) => s.event)).toEqual(["app_active"]);
  });

  it("discards them when the user declines, sending only the opt-out count", async () => {
    const r = rig();
    r.telemetry.setEnvDisabled(false);
    r.telemetry.track("feature_used", { feature: "sala" });
    r.telemetry.optOut("banner");
    await r.settle();
    expect(r.sent.map((s) => s.event)).toEqual(["telemetry_opted_out"]);
    expect(r.sent[0]?.properties).toMatchObject({ source: "banner" });
    expect(r.choice()).toBe(false);
    expect(r.telemetry.track("feature_used", { feature: "sala" })).toBe("dropped");
  });

  it("caps what it holds", () => {
    const r = rig();
    r.telemetry.setEnvDisabled(false);
    const results = Array.from({ length: 120 }, (_, i) => {
      r.advance(70_000 * (i + 1));
      return r.telemetry.track("feature_used", { feature: "sala" });
    });
    expect(results.filter((x) => x === "buffered")).toHaveLength(100);
    expect(results.filter((x) => x === "dropped")).toHaveLength(20);
  });
});

describe("when enabled", () => {
  it("sends at once with the common properties and no person profile", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.track("session_started", { runtime: "claude", model_family: "opus", effort: "high", permission_mode: "plan", kind: "chat" })).toBe("sent");
    await r.settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.properties).toMatchObject({ runtime: "claude", os: "linux", $process_person_profile: false });
  });

  it("drops an event that is off schema without sending anything", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    // @ts-expect-error a property outside the schema is a compile error as well
    expect(r.telemetry.track("feature_used", { feature: "sala", cwd: "/home/x" })).toBe("dropped");
    // @ts-expect-error an event outside the registry
    expect(r.telemetry.track("page_view", {})).toBe("dropped");
    await r.settle();
    expect(r.sent).toEqual([]);
  });

  it("cuts a burst of one event and lets the window reopen", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    const burst = Array.from({ length: 10 }, () => r.telemetry.track("app_active", {}));
    expect(burst.filter((x) => x === "sent")).toHaveLength(3);
    r.advance(61_000);
    expect(r.telemetry.track("app_active", {})).toBe("sent");
    expect(r.telemetry.track("feature_used", { feature: "voice" })).toBe("sent");
    await r.settle();
    expect(r.sent).toHaveLength(5);
  });

  it("sends a daily event once per local day and a once event once ever", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.trackDaily("feature:sala", "feature_used", { feature: "sala" })).toBe("sent");
    expect(r.telemetry.trackDaily("feature:sala", "feature_used", { feature: "sala" })).toBe("dropped");
    expect(r.telemetry.trackDaily("feature:terminal", "feature_used", { feature: "terminal" })).toBe("sent");
    r.advance(24 * 3600 * 1000);
    expect(r.telemetry.trackDaily("feature:sala", "feature_used", { feature: "sala" })).toBe("sent");
    expect(r.telemetry.trackOnce("first_prompt", "first_prompt_sent", { seconds_since_first_open: 10, runtime: "claude" })).toBe("sent");
    expect(r.telemetry.trackOnce("first_prompt", "first_prompt_sent", { seconds_since_first_open: 10, runtime: "claude" })).toBe("dropped");
    await r.settle();
    expect(r.sent).toHaveLength(4);
  });

  it("does not spend a daily mark on an event that was refused", () => {
    const r = rig({}, false);
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.trackDaily("feature:sala", "feature_used", { feature: "sala" })).toBe("dropped");
    r.telemetry.optIn();
    expect(r.telemetry.trackDaily("feature:sala", "feature_used", { feature: "sala" })).toBe("sent");
  });

  it("a no that lands after an event was accepted still wins", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(false);
    expect(r.telemetry.track("app_active", {})).toBe("sent");
    r.telemetry.optOut("settings");
    await r.settle();
    expect(r.sent.map((s) => s.event)).toEqual(["telemetry_opted_out"]);
  });
});

describe("the environment", () => {
  it("beats a saved yes without rewriting it, and sends nothing, not even the opt-out", async () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(true);
    expect(r.telemetry.consentState()).toBe("disabled_by_env");
    expect(r.telemetry.bannerPending()).toBe(false);
    expect(r.telemetry.track("app_active", {})).toBe("dropped");
    r.telemetry.optOut("settings");
    await r.settle();
    expect(r.sent).toEqual([]);
    expect(r.loads()).toBe(0);
    expect(r.choice()).toBe(false);
  });

  it("leaves the saved choice alone when it is set", () => {
    const r = rig({}, true);
    r.telemetry.setEnvDisabled(true);
    expect(r.choice()).toBe(true);
  });

  it("holds events until it has been read, then sends if it allows", async () => {
    const r = rig({}, true);
    expect(r.telemetry.consentState()).toBe("pending_env");
    expect(r.telemetry.bannerPending()).toBe(false);
    expect(r.telemetry.track("app_active", {})).toBe("buffered");
    r.telemetry.setEnvDisabled(false);
    await r.settle();
    expect(r.sent.map((s) => s.event)).toEqual(["app_active"]);
  });

  it("drops what it held when it turns out to forbid sending", async () => {
    const r = rig({}, true);
    r.telemetry.track("app_active", {});
    r.telemetry.setEnvDisabled(true);
    await r.settle();
    expect(r.sent).toEqual([]);
  });
});

describe("a blocked SDK", () => {
  it("costs the event and never throws", async () => {
    const r = rig({ loadSdk: () => Promise.reject(new Error("blocked")) }, true);
    r.telemetry.setEnvDisabled(false);
    expect(() => r.telemetry.track("app_active", {})).not.toThrow();
    await r.settle();
    expect(r.sent).toEqual([]);
  });
});
