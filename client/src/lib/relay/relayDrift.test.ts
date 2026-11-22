import { describe, expect, it } from "vitest";
import { shouldAutoUpdateRelay } from "@/lib/relay/relayDrift";

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
