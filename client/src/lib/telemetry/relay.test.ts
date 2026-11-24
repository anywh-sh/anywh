import { describe, expect, it } from "vitest";
import { installerCode, relayUpdatePath, relayVsApp, updateRequestResult, versionOrNone } from "@/lib/telemetry/relay";

describe("what a relay's answers reduce to", () => {
  it("compares releases, and calls a build from source or a silent relay unknown", () => {
    expect(relayVsApp("0.2.40", "0.2.41")).toBe("older");
    expect(relayVsApp("0.2.41", "0.2.41")).toBe("same");
    expect(relayVsApp("0.3.0", "0.2.41")).toBe("newer");
    expect(relayVsApp(undefined, "0.2.41")).toBe("unknown");
    expect(relayVsApp("0.0.0", "0.2.41")).toBe("unknown");
    expect(relayVsApp("0.2.40", "0.0.0")).toBe("unknown");
  });

  it("names how a relay gets updated from what it says about itself", () => {
    expect(relayUpdatePath({ features: ["bots", "self_update"], platform: "linux" })).toBe("self_update");
    expect(relayUpdatePath({ features: ["bots"], platform: "darwin", updateSupport: "managed_elsewhere" })).toBe("homebrew");
    expect(relayUpdatePath({ platform: "linux" })).toBe("installer");
    expect(relayUpdatePath({ features: [], platform: "linux", updateSupport: "source_checkout" })).toBe("none");
  });

  it("keeps the relay's refusal codes and nothing else it says", () => {
    expect(updateRequestResult(undefined)).toBe("accepted");
    expect(updateRequestResult(new Error("busy"))).toBe("busy");
    expect(updateRequestResult(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(updateRequestResult(new Error("HTTP 500"))).toBe("other");
    expect(installerCode("checksum_mismatch")).toBe("checksum_mismatch");
    expect(installerCode("rm: /home/someone")).toBe("other");
    expect(installerCode(undefined)).toBeUndefined();
    expect(versionOrNone("v0.2.40")).toBeUndefined();
    expect(versionOrNone("0.2.40")).toBe("0.2.40");
  });
});
