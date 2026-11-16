import { describe, expect, it } from "vitest";
import { isAgentSignedOut, publishPlanUsageRefresh, requestPlanUsageRefresh } from "@/lib/planUsage/signedOutAgents";
import type { ProfilePlanUsage } from "@/lib/planUsage/derive";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";

function entry(connection: ProfilePlanUsage["connection"], runtimes: RuntimePlanUsage[] | null): ProfilePlanUsage {
  return { connection, runtimes, observedAt: 1, receivedAt: 1, refreshing: false };
}

const signedOut: RuntimePlanUsage = { runtime: "claude", status: "signed_out", windows: [], observedAt: null };
const ok: RuntimePlanUsage = { runtime: "codex", status: "ok", windows: [], observedAt: 1 };

describe("isAgentSignedOut", () => {
  it("is true only for that agent, on that profile, on a live read", () => {
    const state = { work: entry("live", [signedOut, ok]) };
    expect(isAgentSignedOut(state, "work", "claude")).toBe(true);
    expect(isAgentSignedOut(state, "work", "codex")).toBe(false);
    expect(isAgentSignedOut(state, "home", "claude")).toBe(false);
  });

  it("says nothing from stale data: the login may have come back meanwhile", () => {
    expect(isAgentSignedOut({ work: entry("offline", [signedOut]) }, "work", "claude")).toBe(false);
    expect(isAgentSignedOut({ work: entry("live", null) }, "work", "claude")).toBe(false);
  });
});

describe("requestPlanUsageRefresh", () => {
  it("reaches whatever App published, and is a no-op before that", () => {
    requestPlanUsageRefresh("work", "claude");
    const calls: string[] = [];
    publishPlanUsageRefresh((profileId, runtime) => calls.push(`${profileId}:${runtime}`));
    requestPlanUsageRefresh("work", "claude");
    expect(calls).toEqual(["work:claude"]);
  });
});
