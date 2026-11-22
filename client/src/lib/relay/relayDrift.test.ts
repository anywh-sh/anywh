import { describe, expect, it } from "vitest";
import { evaluateRelayDrift, shouldAutoUpdateRelay } from "@/lib/relay/relayDrift";

const APP_VERSION = "0.1.8";
const MIN_RELAY_VERSION = "0.0.0";

describe("evaluateRelayDrift", () => {
  it("says nothing about a relay with no known version", () => {
    expect(evaluateRelayDrift(null, APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "none",
      action: null,
    });
  });

  it("says nothing about a relay run from a checkout, which no release stamped", () => {
    expect(evaluateRelayDrift("0.0.0", APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "none",
      action: null,
    });
  });

  it("says nothing when the relay is newer than the app — normal for a self-hosted upgrade", () => {
    expect(evaluateRelayDrift("0.1.9", APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "none",
      action: null,
    });
  });

  it("says nothing when the relay and app match", () => {
    expect(evaluateRelayDrift(APP_VERSION, APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "none",
      action: null,
    });
  });

  it("is an affordance for a relay older by any margin, not just a large one", () => {
    expect(evaluateRelayDrift("0.1.7", APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "affordance",
      action: "update-in-app",
    });
    expect(evaluateRelayDrift("0.0.1", APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "affordance",
      action: "update-in-app",
    });
  });

  it("offers brew upgrade instead of the in-app path on macOS", () => {
    expect(evaluateRelayDrift("0.1.7", APP_VERSION, MIN_RELAY_VERSION, "macos")).toEqual({
      severity: "affordance",
      action: "brew-upgrade",
    });
  });

  it("escalates to banner severity only once MIN_RELAY_VERSION is actually raised past the relay", () => {
    // With today's floor ("0.0.0") this never happens — the point of the
    // constant is that it fires for nothing until deliberately bumped.
    expect(evaluateRelayDrift("0.1.7", APP_VERSION, "0.0.0", "linux").severity).toBe("affordance");
    expect(evaluateRelayDrift("0.1.7", APP_VERSION, "0.1.8", "linux").severity).toBe("banner");
  });

  it("ignores a malformed relay version rather than guessing", () => {
    expect(evaluateRelayDrift("not-a-version", APP_VERSION, MIN_RELAY_VERSION, "linux")).toEqual({
      severity: "none",
      action: null,
    });
  });
});

describe("shouldAutoUpdateRelay", () => {
  const can = ["bots", "self_update"];

  it("asks a relay that can update itself and runs an older release", () => {
    expect(shouldAutoUpdateRelay({ version: "0.2.40", features: can }, "0.2.41")).toBe(true);
    expect(shouldAutoUpdateRelay({ version: "0.2.9", features: can }, "0.2.10")).toBe(true);
  });

  it("never a relay on the same or a newer release: no downgrade", () => {
    expect(shouldAutoUpdateRelay({ version: "0.2.41", features: can }, "0.2.41")).toBe(false);
    expect(shouldAutoUpdateRelay({ version: "0.2.42", features: can }, "0.2.41")).toBe(false);
  });

  it("never a relay that cannot update itself; that one gets the per-profile affordance", () => {
    expect(shouldAutoUpdateRelay({ version: "0.2.40", features: ["bots"] }, "0.2.41")).toBe(false);
    expect(shouldAutoUpdateRelay({ version: "0.2.40" }, "0.2.41")).toBe(false);
  });

  it("nothing from or to a build from source: there is no release to point at", () => {
    expect(shouldAutoUpdateRelay({ version: "0.0.0", features: can }, "0.2.41")).toBe(false);
    expect(shouldAutoUpdateRelay({ version: "0.2.40", features: can }, "0.0.0")).toBe(false);
    expect(shouldAutoUpdateRelay({ features: can }, "0.2.41")).toBe(false);
  });
});
