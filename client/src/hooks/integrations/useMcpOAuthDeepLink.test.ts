import { StrictMode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsClientMessage } from "@/lib/integrations/model";

let openUrlHandler: ((urls: string[]) => void) | undefined;

const { getCurrentMock } = vi.hoisted(() => ({
  getCurrentMock: vi.fn((): Promise<string[] | null> => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: () => getCurrentMock(),
  onOpenUrl: (handler: (urls: string[]) => void) => {
    openUrlHandler = handler;
    return Promise.resolve(() => {});
  },
}));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));

import { useMcpOAuthDeepLink } from "@/hooks/integrations/useMcpOAuthDeepLink";
import {
  CALLBACK_GRACE_MS,
  __resetMcpOAuthForTests,
  getMcpOAuthNotice,
  noteAuthFlow,
  registerIntegrationsSender,
} from "@/lib/integrations/oauthDeepLink";

const LINK = "anywh://mcp-oauth/callback?code=abc&state=st-2";

let sentByProfile: Record<string, IntegrationsClientMessage[]>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetMcpOAuthForTests();
  getCurrentMock.mockReset();
  getCurrentMock.mockResolvedValue(null);
  openUrlHandler = undefined;
  sentByProfile = { p1: [], p2: [] };
  for (const id of ["p1", "p2"]) registerIntegrationsSender(id, (message) => (sentByProfile[id].push(message), true));
  noteAuthFlow("p1", { flowId: "f1", runtimeId: "claude", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", state: "st-1" });
  noteAuthFlow("p2", { flowId: "f2", runtimeId: "codex", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", state: "st-2" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useMcpOAuthDeepLink", () => {
  it("routes a link that arrives while running to the profile of its state", async () => {
    renderHook(() => useMcpOAuthDeepLink());
    await vi.runAllTimersAsync();
    openUrlHandler?.([LINK]);
    expect(sentByProfile.p2).toEqual([{ type: "mcp_auth_complete", flowId: "f2", callbackUrl: LINK }]);
    expect(sentByProfile.p1).toEqual([]);
  });

  it("routes a cold-launch link once under StrictMode", async () => {
    getCurrentMock.mockResolvedValue([LINK]);
    renderHook(() => useMcpOAuthDeepLink(), { wrapper: StrictMode });
    await vi.runAllTimersAsync();
    openUrlHandler?.([LINK]);
    expect(sentByProfile.p2).toHaveLength(1);
  });

  it("drops a link with an unknown state and ignores other deep links", async () => {
    renderHook(() => useMcpOAuthDeepLink());
    await vi.runAllTimersAsync();
    openUrlHandler?.(["anywh://mcp-oauth/callback?code=abc&state=nobody", "anywh://import-profile/?label=x&host=h&port=1"]);
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);
    expect(sentByProfile).toEqual({ p1: [], p2: [] });
    expect(getMcpOAuthNotice()?.kind).toBe("unknown");
  });
});
