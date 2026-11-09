import { describe, expect, it } from "vitest";
import { scrubEvent } from "@/lib/telemetry/scrub";

describe("scrubEvent", () => {
  it("keeps $geoip_disable and the ingestion keys, drops every other $ key", () => {
    const out = scrubEvent({
      event: "x",
      properties: {
        token: "t",
        distinct_id: "d",
        $geoip_disable: true,
        $process_person_profile: false,
        $lib: "web",
        $lib_version: "1",
        $current_url: "http://x",
        $ip: "1.2.3.4",
        $browser: "Chrome",
        feature: "sala",
      },
    });
    expect(Object.keys(out.properties).sort()).toEqual(["$geoip_disable", "$lib", "$lib_version", "$process_person_profile", "distinct_id", "feature", "token"]);
    expect(out.properties.$geoip_disable).toBe(true);
  });
});
