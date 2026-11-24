import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles, type Profile } from "@/lib/profiles/profiles";
import { formatClockTime } from "@/lib/format/relativeTime";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * ENG-104: a resume-budget refusal (the broker's 429 with `retry_at`) shows
 * when the machine can be woken again, in place of "Reconnecting…", and the
 * chat tab makes no attempt before then. The broker and sidecar are the
 * mocked seam, as in revokedBackgroundProfile.test.tsx (see its comment for
 * why); the RelayClient, the hook and the chat panel are real.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const RETRY_AFTER_MS = 20 * 60_000;
let refusing: boolean;
/** What the broker says once the refusal has cleared. */
let afterRefusal: "grant" | "asleep";
let retryAt: Date;
let grantCalls: number;

vi.mock("@/lib/profiles/tailnetBroker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles/tailnetBroker")>();
  return {
    ...actual,
    fetchConnectGrant: vi.fn((profile: Profile) => {
      grantCalls += 1;
      // The real 429 handling, fed the body ENG-100's control plane sends,
      // for as long as the budget is spent.
      if (refusing && Date.now() < retryAt.getTime()) {
        return Promise.reject(
          actual.refusedWith429(profile.id, {
            error: "resume_budget_exhausted",
            retry_at: retryAt.toISOString(),
            retry_after_ms: retryAt.getTime() - Date.now(),
          }),
        );
      }
      if (refusing && afterRefusal === "asleep") return Promise.reject(new actual.BrokerAsleepError());
      return Promise.resolve({ endpoint: { host: "100.64.0.9", port: 8443 }, token: `grant-${String(grantCalls)}` });
    }),
  };
});
vi.mock("@/lib/profiles/tailnetSidecar", () => ({
  acquireTailnetSidecar: vi.fn(() => Promise.resolve({ host: "127.0.0.1", port: 9001 })),
  releaseTailnetSidecar: vi.fn(),
  peekTailnetSidecar: vi.fn(() => Promise.resolve({ host: "127.0.0.1", port: 9001 })),
  retargetTailnetSidecar: vi.fn(() => Promise.resolve({ host: "127.0.0.1", port: 9001 })),
}));

const tailnetProfile: Profile = {
  id: "tailnet-profile",
  label: "Sandbox",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  brokerUrl: "https://broker.test/v1/connect/w1",
  brokerNodeId: "node-1",
};

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  private readonly listeners: Record<string, Array<(event: { data?: string }) => void>> = {
    open: [],
    close: [],
    message: [],
  };

  constructor(readonly url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatch("open", {});
      this.emit({ type: "caught_up" });
    });
  }

  addEventListener(type: string, handler: (event: { data?: string }) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (event: { data?: string }) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { type?: string };
    if (message.type !== "user_message") return;
    queueMicrotask(() => {
      this.emit({ type: "agent_event", event: { type: "text", text: "reply" } });
      this.emit({ type: "agent_event", event: { type: "turn_ended", stopped: false } });
    });
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.dispatch("close", {});
  }

  emit(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  private dispatch(type: string, event: { data?: string }): void {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

let sockets: FakeSocket[];

beforeEach(() => {
  localStorage.clear();
  sockets = [];
  refusing = false;
  afterRefusal = "grant";
  grantCalls = 0;
  retryAt = new Date(Date.now() + RETRY_AFTER_MS);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("fetch not scripted in this test"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resume-budget refusal", () => {
  it("says when the machine can be woken again instead of reconnecting, and attempts nothing before then", async () => {
    setProfiles([tailnetProfile]);
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const chatSocket = await vi.waitFor(() => {
      const socket = sockets.find((s) => s.url.includes("?session="));
      expect(socket).toBeDefined();
      return socket!;
    });

    // The sandbox went to sleep; every wake since spent the hourly budget.
    refusing = true;
    chatSocket.close();

    const expected = en.chat.connection.wakeBudgetExhausted.split("{time}").join(formatClockTime(retryAt.getTime(), "en"));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The status bar says it too, instead of "Reconnecting…".
    const time = formatClockTime(retryAt.getTime(), "en");
    expect(await screen.findByText(en.shell.statusBar.wakePaused.split("{time}").join(time))).toBeInTheDocument();
    expect(screen.queryByText(en.chat.connection.reconnecting)).not.toBeInTheDocument();

    // The client waits for the hint, not its usual sub-second backoff.
    const chatSockets = sockets.filter((s) => s.url.includes("?session=")).length;
    const callsAfterRefusal = grantCalls;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(grantCalls).toBe(callsAfterRefusal);
    expect(sockets.filter((s) => s.url.includes("?session="))).toHaveLength(chatSockets);
  });

  it("stops showing the time once it has passed, even when the next attempt finds the machine asleep", async () => {
    // The retry after the refusal is a timer's (wake=false), so a sandbox
    // that went to sleep meanwhile answers "asleep": not a throttle, and not
    // a connection. A time in the past must not stay on screen.
    retryAt = new Date(Date.now() + 1_500);
    afterRefusal = "asleep";
    setProfiles([{ ...tailnetProfile, id: "short-hold" }]);
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const chatSocket = await vi.waitFor(() => {
      const socket = sockets.find((s) => s.url.includes("?session="));
      expect(socket).toBeDefined();
      return socket!;
    });

    refusing = true;
    chatSocket.close();
    const shown = en.chat.connection.wakeBudgetExhausted.split("{time}").join(formatClockTime(retryAt.getTime(), "en"));
    expect(await screen.findByText(shown)).toBeInTheDocument();

    await vi.waitFor(() => expect(screen.queryByText(shown)).not.toBeInTheDocument(), { timeout: 4000 });
  });
});
