import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileIntegrations } from "@/lib/integrations/derive";
import type { IntegrationState } from "@/lib/integrations/model";
import { __resetMcpOAuthForTests, routeMcpOAuthCallback } from "@/lib/integrations/oauthDeepLink";
import { HANDSHAKE_TIMEOUT_MS, IntegrationsWatch, parseServerMessage } from "@/lib/integrations/watch";
import type { Profile } from "@/lib/profiles/profiles";
import { installFakeRelay, type FakeRelay } from "../../../tests/ui/helpers/fakeRelay";

const PROFILE: Profile = { id: "work", label: "Work", host: "127.0.0.1", relayPort: 8101 };
const RELAY = "127.0.0.1:8101";

const JIRA: IntegrationState = {
  id: "jira",
  provider: "jira",
  runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "needs_auth", authMode: "oauth", alternatives: 0 }],
  prefs: { project: null },
  queries: [],
};

let relay: FakeRelay;
let watch: IntegrationsWatch | undefined;
let states: ProfileIntegrations[];

function startWatch(): IntegrationsWatch {
  states = [];
  watch = new IntegrationsWatch(PROFILE, { wake: true, onChange: (state) => states.push(state) });
  watch.start();
  return watch;
}

const watchSockets = () => relay.sockets.filter((socket) => new URL(socket.url).pathname === "/integrations/watch");

beforeEach(() => {
  vi.useFakeTimers();
  __resetMcpOAuthForTests();
});

afterEach(() => {
  watch?.stop();
  watch = undefined;
  relay.uninstall();
  vi.useRealTimers();
});

describe("IntegrationsWatch", () => {
  it("keeps the relay's state and sends on the live socket", async () => {
    relay = installFakeRelay("", { integrations: { [RELAY]: { integrations: [JIRA] } } });
    const live = startWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(live.current.connection).toBe("live");
    expect(live.current.integrations).toEqual([JIRA]);

    expect(live.send({ type: "integration_prefs", id: "jira", prefs: { project: "NGL" } })).toBe(true);
    expect(relay.sent.map((entry) => entry.message.type)).toContain("integration_prefs");

    relay.emitIntegrations(RELAY, []);
    expect(live.current.integrations).toEqual([]);
  });

  it("keeps every session's work ticket through the relay's updates", async () => {
    const link = (sessionId: string, key: string) => ({ sessionId, ticket: { provider: "jira" as const, site: "cloud-1", key }, origin: "manual" as const, linkedAt: 1, lineDue: false });
    relay = installFakeRelay("", { integrations: { [RELAY]: { integrations: [JIRA], links: [link("s1", "NGL-1")] } } });
    const live = startWatch();
    expect(live.current.workTickets).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(live.current.workTickets ?? {})).toEqual(["s1"]);

    relay.emitOnIntegrations(RELAY, { type: "work_ticket_upsert", link: link("s2", "NGL-2") });
    relay.emitOnIntegrations(RELAY, { type: "work_ticket_removed", sessionId: "s1" });
    expect(live.current.workTickets).toEqual({ s2: link("s2", "NGL-2") });
  });

  it("marks an older relay unsupported for good and never redials it", async () => {
    relay = installFakeRelay("", { integrations: { [RELAY]: "legacy" } });
    const old = startWatch();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(old.current.connection).toBe("unsupported");
    expect(watchSockets()).toHaveLength(1);
    expect(old.send({ type: "ping" })).toBe(false);
  });

  it("backs off while the machine is unreachable and keeps the last state", async () => {
    relay = installFakeRelay("", { integrations: { [RELAY]: { integrations: [JIRA] } } });
    const flaky = startWatch();
    await vi.advanceTimersByTimeAsync(0);
    relay.integrations[RELAY] = "unreachable";
    watchSockets()[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(flaky.current.connection).toBe("offline");
    expect(flaky.current.integrations).toEqual([JIRA]);

    // 2s, then 4s, then 8s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(watchSockets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(watchSockets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchSockets()).toHaveLength(3);

    relay.integrations[RELAY] = { integrations: [] };
    await vi.advanceTimersByTimeAsync(8_000);
    expect(flaky.current.connection).toBe("live");
    expect(flaky.current.integrations).toEqual([]);
  });

  it("drops a socket that opens but never sends its state, and dials again", async () => {
    relay = installFakeRelay("", { integrations: { [RELAY]: "mute" } });
    const silent = startWatch();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    expect(silent.current.connection).toBe("connecting");
    relay.integrations[RELAY] = { integrations: [JIRA] };
    await vi.advanceTimersByTimeAsync(1);
    expect(silent.current.connection).toBe("offline");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(silent.current.connection).toBe("live");
    expect(watchSockets()).toHaveLength(2);
  });

  it("is the way a sign-in callback reaches its relay", async () => {
    relay = installFakeRelay("", { integrations: { [RELAY]: { integrations: [JIRA] } } });
    startWatch();
    await vi.advanceTimersByTimeAsync(0);
    watchSockets()[0].emitMessage({ type: "mcp_auth_flow", flowId: "f9", runtimeId: "claude", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", state: "st-9" });
    expect(watch?.current.authFlows.f9?.state).toBe("st-9");

    routeMcpOAuthCallback("anywh://mcp-oauth/callback?code=c&state=st-9");
    expect(relay.sent.map((entry) => entry.message)).toContainEqual({
      type: "mcp_auth_complete",
      flowId: "f9",
      callbackUrl: "anywh://mcp-oauth/callback?code=c&state=st-9",
    });
  });
});

describe("parseServerMessage", () => {
  it("keeps well-formed work tickets only", () => {
    const good = { sessionId: "s1", ticket: { provider: "jira", site: "cloud-1", key: "NGL-1" }, origin: "start", linkedAt: 1, lineDue: false };
    const raw = JSON.stringify({ type: "work_tickets_state", links: [good, { sessionId: "s2", ticket: { key: "bad" } }] });
    expect(parseServerMessage(raw)).toEqual({ type: "work_tickets_state", links: [good] });
    expect(parseServerMessage(JSON.stringify({ type: "work_ticket_upsert", link: { sessionId: "s3" } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "work_ticket_removed", sessionId: "s1" }))).toEqual({ type: "work_ticket_removed", sessionId: "s1" });
  });

  it("keeps well-formed integrations only and ignores messages it does not know", () => {
    const raw = JSON.stringify({ type: "integrations_state", integrations: [JIRA, { id: "x" }, null] });
    expect(parseServerMessage(raw)).toEqual({ type: "integrations_state", integrations: [JIRA] });
    expect(parseServerMessage(JSON.stringify({ type: "work_ticket_result", sessionId: "s", ok: true }))).toBeNull();
    expect(parseServerMessage("nope")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "mcp_auth_flow", phase: "done" }))).toBeNull();
  });
});
