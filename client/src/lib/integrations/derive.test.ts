import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE_INTEGRATIONS,
  addableProviders,
  integrationDataState,
  pickFetchRuntime,
  railBadge,
  railIntegrations,
  runtimesNeedingAuth,
  type ProfileIntegrations,
} from "@/lib/integrations/derive";
import type { IntegrationRuntime, IntegrationState } from "@/lib/integrations/model";

function runtime(patch: Partial<IntegrationRuntime>): IntegrationRuntime {
  return { runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0, ...patch };
}

function jira(runtimes: IntegrationRuntime[], patch: Partial<IntegrationState> = {}): IntegrationState {
  return { id: "jira", provider: "jira", runtimes, prefs: { project: null }, queries: [], ...patch };
}

function entry(patch: Partial<ProfileIntegrations>): ProfileIntegrations {
  return { ...EMPTY_PROFILE_INTEGRATIONS, ...patch };
}

describe("integrationDataState", () => {
  it("separates live, stale, nothing yet and an old relay", () => {
    expect(integrationDataState(undefined)).toBe("none");
    expect(integrationDataState(entry({}))).toBe("none");
    expect(integrationDataState(entry({ connection: "live", integrations: [] }))).toBe("live");
    expect(integrationDataState(entry({ connection: "offline", integrations: [] }))).toBe("stale");
    expect(integrationDataState(entry({ connection: "unsupported" }))).toBe("unsupported");
    expect(integrationDataState(entry({ connection: "revoked", integrations: [] }))).toBe("unsupported");
  });
});

describe("railIntegrations", () => {
  it("shows an integration only while some CLI has a server for it, stale included", () => {
    const shown = jira([runtime({})]);
    const gone = jira([], { id: "jira-2" });
    expect(railIntegrations(entry({ connection: "offline", integrations: [shown, gone] }))).toEqual([shown]);
    expect(railIntegrations(entry({ connection: "unsupported", integrations: [shown] }))).toEqual([]);
  });

  it("keeps only an integration some CLI is connected to", () => {
    const partly = jira([runtime({ status: "connected" }), runtime({ runtimeId: "codex", status: "needs_auth" })]);
    const signIn = jira([runtime({ status: "needs_auth" })], { id: "jira-2" });
    const broken = jira([runtime({ status: "failed" }), runtime({ runtimeId: "codex", status: "unknown" })], { id: "jira-3" });
    expect(railIntegrations(entry({ connection: "live", integrations: [partly, signIn, broken] }))).toEqual([partly]);
  });
});

describe("railBadge", () => {
  it("is amber when any CLI must sign in, even with another failed", () => {
    expect(railBadge(jira([runtime({ status: "failed" }), runtime({ runtimeId: "codex", status: "needs_auth" })]))).toBe("needs_auth");
  });

  it("is red for a failed server, and absent when all is well or unknown", () => {
    expect(railBadge(jira([runtime({ status: "failed" })]))).toBe("failed");
    expect(railBadge(jira([runtime({}), runtime({ runtimeId: "codex", status: "unknown" })]))).toBeNull();
  });

  it("counts the CLIs that must sign in", () => {
    expect(runtimesNeedingAuth(jira([runtime({ status: "needs_auth" }), runtime({ runtimeId: "codex", status: "needs_auth" })]))).toBe(2);
  });
});

describe("pickFetchRuntime", () => {
  it("takes the relay's choice, else a connected CLI, Codex first", () => {
    expect(pickFetchRuntime(jira([runtime({})], { fetchRuntime: "claude" }))).toBe("claude");
    expect(pickFetchRuntime(jira([runtime({}), runtime({ runtimeId: "codex" })]))).toBe("codex");
    expect(pickFetchRuntime(jira([runtime({}), runtime({ runtimeId: "codex", status: "needs_auth" })]))).toBe("claude");
    expect(pickFetchRuntime(jira([runtime({ status: "needs_auth" })]))).toBeUndefined();
  });
});

describe("addableProviders", () => {
  it("offers Jira on a live relay until some agent is connected to it", () => {
    expect(addableProviders(entry({ connection: "live", integrations: [] }))).toEqual(["jira"]);
    expect(addableProviders(entry({ connection: "live", integrations: [jira([])] }))).toEqual(["jira"]);
    expect(addableProviders(entry({ connection: "live", integrations: [jira([runtime({ status: "needs_auth" })])] }))).toEqual(["jira"]);
    expect(addableProviders(entry({ connection: "live", integrations: [jira([runtime({ status: "connected" }), runtime({ runtimeId: "codex", status: "needs_auth" })])] }))).toEqual([]);
    expect(addableProviders(entry({ connection: "offline", integrations: [] }))).toEqual([]);
    expect(addableProviders(entry({ connection: "unsupported" }))).toEqual([]);
  });
});
