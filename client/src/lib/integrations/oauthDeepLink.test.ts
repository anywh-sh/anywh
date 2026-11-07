import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsClientMessage, McpAuthFlow } from "@/lib/integrations/model";
import {
  CALLBACK_GRACE_MS,
  DELIVERED_TTL_MS,
  __resetMcpOAuthForTests,
  forgetProfileFlows,
  getMcpOAuthNotice,
  isMcpOAuthLink,
  noteAuthFlow,
  parseMcpOAuthCallback,
  registerIntegrationsSender,
  routeMcpOAuthCallback,
} from "@/lib/integrations/oauthDeepLink";

const CLAUDE_LINK = "anywh://mcp-oauth/callback?code=c1&state=s-claude";
const CODEX_LINK = "anywh://mcp-oauth/callback/7?code=c2&state=s-codex";

function flow(patch: Partial<McpAuthFlow>): McpAuthFlow {
  return { flowId: "f1", runtimeId: "claude", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", ...patch };
}

function recorder(): { sent: IntegrationsClientMessage[]; send: (message: IntegrationsClientMessage) => boolean } {
  const sent: IntegrationsClientMessage[] = [];
  return { sent, send: (message) => (sent.push(message), true) };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetMcpOAuthForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseMcpOAuthCallback", () => {
  it("reads both runtimes' callback shapes", () => {
    expect(parseMcpOAuthCallback(CLAUDE_LINK)).toEqual({ url: CLAUDE_LINK, state: "s-claude" });
    expect(parseMcpOAuthCallback(CODEX_LINK)).toEqual({ url: CODEX_LINK, state: "s-codex" });
    expect(parseMcpOAuthCallback("anywh://mcp-oauth/callback?error=access_denied&state=s")?.state).toBe("s");
  });

  it("rejects other hosts, other paths and a missing state", () => {
    expect(parseMcpOAuthCallback("anywh://import-profile/callback?state=s")).toBeNull();
    expect(parseMcpOAuthCallback("anywh://mcp-oauth/callbacks?state=s")).toBeNull();
    expect(parseMcpOAuthCallback("anywh://mcp-oauth/callback?code=c")).toBeNull();
    expect(parseMcpOAuthCallback("https://mcp-oauth/callback?state=s")).toBeNull();
    expect(isMcpOAuthLink("anywh://import-profile/?label=x")).toBe(false);
    expect(isMcpOAuthLink("anywh://mcp-oauth/whatever")).toBe(true);
  });
});

describe("routeMcpOAuthCallback", () => {
  it("forwards a link to the profile whose flow carries its state, and only once", () => {
    const work = recorder();
    const home = recorder();
    registerIntegrationsSender("work", work.send);
    registerIntegrationsSender("home", home.send);
    noteAuthFlow("work", flow({ flowId: "w1", state: "s-other" }));
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", state: "s-codex" }));

    expect(routeMcpOAuthCallback(CODEX_LINK)).toBe(true);
    routeMcpOAuthCallback(CODEX_LINK);

    expect(home.sent).toEqual([{ type: "mcp_auth_complete", flowId: "h1", callbackUrl: CODEX_LINK }]);
    expect(work.sent).toEqual([]);
  });

  it("takes a repeat of a forwarded link quietly, even once its flow is announced again or ended", () => {
    const home = recorder();
    registerIntegrationsSender("home", home.send);
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", state: "s-codex" }));
    routeMcpOAuthCallback(CODEX_LINK);

    // The relay reports the flow finishing (still not terminal), then done.
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", phase: "completing", state: "s-codex" }));
    routeMcpOAuthCallback(CODEX_LINK);
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", phase: "done", state: "s-codex" }));
    routeMcpOAuthCallback(CODEX_LINK);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(home.sent).toHaveLength(1);
    expect(getMcpOAuthNotice()).toBeNull();

    // A retry with a new code for the same sign-in is no repeat.
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", state: "s-codex" }));
    routeMcpOAuthCallback("anywh://mcp-oauth/callback/7?code=c3&state=s-codex");
    expect(home.sent).toHaveLength(2);

    // Long after, the old link is just a link nobody waits for.
    vi.advanceTimersByTime(DELIVERED_TTL_MS);
    routeMcpOAuthCallback(CODEX_LINK);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(getMcpOAuthNotice()?.kind).toBe("unknown");
  });

  it("sends a repeat again once the relay it went to reconnected (the first copy may have died with the socket)", () => {
    const home = recorder();
    registerIntegrationsSender("home", home.send);
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", state: "s-codex" }));
    routeMcpOAuthCallback(CODEX_LINK);
    // The socket dropped before the relay read it; the relay re-announces.
    forgetProfileFlows("home");
    noteAuthFlow("home", flow({ flowId: "h1", runtimeId: "codex", state: "s-codex" }));
    routeMcpOAuthCallback(CODEX_LINK);
    expect(home.sent).toEqual([
      { type: "mcp_auth_complete", flowId: "h1", callbackUrl: CODEX_LINK },
      { type: "mcp_auth_complete", flowId: "h1", callbackUrl: CODEX_LINK },
    ]);
  });

  it("leaves links that are not MCP sign-ins to other listeners", () => {
    expect(routeMcpOAuthCallback("anywh://import-profile/?label=x&host=h&port=1")).toBe(false);
  });

  it("holds a link until its flow and its socket arrive (a cold launch)", () => {
    routeMcpOAuthCallback(CLAUDE_LINK);
    const work = recorder();
    registerIntegrationsSender("work", work.send);
    expect(work.sent).toEqual([]);
    noteAuthFlow("work", flow({ state: "s-claude" }));
    expect(work.sent).toEqual([{ type: "mcp_auth_complete", flowId: "f1", callbackUrl: CLAUDE_LINK }]);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(getMcpOAuthNotice()).toBeNull();
  });

  it("drops a link nobody waits for, sends nothing and says so", () => {
    const work = recorder();
    registerIntegrationsSender("work", work.send);
    noteAuthFlow("work", flow({ state: "s-other" }));
    routeMcpOAuthCallback(CLAUDE_LINK);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(work.sent).toEqual([]);
    expect(getMcpOAuthNotice()?.kind).toBe("unknown");
    // Too late: the flow showing up now does not revive it.
    noteAuthFlow("work", flow({ state: "s-claude" }));
    expect(work.sent).toEqual([]);
  });

  it("says the relay was unreachable when the flow is known but its socket never came", () => {
    noteAuthFlow("work", flow({ state: "s-claude" }));
    registerIntegrationsSender("work", () => false);
    routeMcpOAuthCallback(CLAUDE_LINK);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(getMcpOAuthNotice()?.kind).toBe("unreachable");
  });

  it("stops routing to a flow once it ended, and never to a claude.ai one", () => {
    const work = recorder();
    registerIntegrationsSender("work", work.send);
    noteAuthFlow("work", flow({ state: "s-claude" }));
    noteAuthFlow("work", flow({ phase: "cancelled" }));
    noteAuthFlow("work", flow({ flowId: "f2", mode: "claudeai", state: "s-codex" }));
    routeMcpOAuthCallback(CLAUDE_LINK);
    routeMcpOAuthCallback(CODEX_LINK);
    vi.advanceTimersByTime(CALLBACK_GRACE_MS);
    expect(work.sent).toEqual([]);
  });

  it("an unregistered socket's sender is not replaced by its own late cleanup", () => {
    const first = recorder();
    const second = recorder();
    const unregisterFirst = registerIntegrationsSender("work", first.send);
    registerIntegrationsSender("work", second.send);
    unregisterFirst();
    noteAuthFlow("work", flow({ state: "s-claude" }));
    routeMcpOAuthCallback(CLAUDE_LINK);
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
  });
});
