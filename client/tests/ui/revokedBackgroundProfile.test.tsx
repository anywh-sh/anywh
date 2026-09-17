import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles, type Profile } from "@/lib/profiles/profiles";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * Full-chain reproduction: a background chat
 * tab on a brokered/tailnet profile should detect its own revocation (WS
 * close -> reconnect -> broker 410) and RevokedProfileBanners should show it
 * even while a different profile is active. Unlike RevokedProfileBanner.test.tsx
 * (which calls markProfileRevoked directly), this drives the real detection
 * chain — RelayClient's close/reconnect logic and useRelayClient's onRevoked
 * wiring — through a faked WebSocket, the same way sendMessage.test.tsx does
 * for the plain-profile path.
 *
 * `tailnetBroker`/`tailnetSidecar` are mocked directly (not exercised for
 * real) rather than flipping `inTauri()` true: that would also turn on every
 * OTHER Tauri-gated hook mounted by <App/> (window controls, notifications,
 * `@tauri-apps/plugin-os`, ...), none of which this scenario is about. The
 * broker/token layer's own HTTP contract is already covered by
 * tailnetBroker.test.ts; this test's job is only what happens once a 410
 * comes back — same "one deliberate seam at the edge, real code everywhere
 * else" idea .anywh/skills/tests/SKILL.md sets for the `claude` process
 * boundary.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let revoked: boolean;

vi.mock("@/lib/profiles/tailnetBroker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles/tailnetBroker")>();
  return {
    ...actual,
    fetchConnectGrant: vi.fn(async () => {
      if (revoked) throw new actual.BrokerRevokedError();
      return { endpoint: { host: "100.64.0.9", port: 8443 }, token: `grant-${String(Date.now())}` };
    }),
    resolveTailnetTarget: vi.fn(async () => ({ target: "100.64.0.9:8443" })),
    reportTailnetKey: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/profiles/tailnetSidecar", () => ({
  acquireTailnetSidecar: vi.fn(async () => ({ host: "127.0.0.1", port: 9001 })),
  releaseTailnetSidecar: vi.fn(),
  peekTailnetSidecar: vi.fn(() => Promise.resolve({ host: "127.0.0.1", port: 9001 })),
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

const otherProfile: Profile = {
  id: "other-profile",
  label: "Trabalho",
  host: "192.168.0.50",
  relayPort: 8765,
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
  revoked = false;
  vi.stubGlobal("WebSocket", FakeSocket);
  // useSessionNames' one-shot `fetchSessions` (unrelated to this test) would
  // otherwise hit a real, nothing-listening 127.0.0.1:9001 — already
  // tolerated by the app (a .catch there), but noisy in test output.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("fetch not scripted in this test"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("revocation of a non-active profile's background chat tab", () => {
  it("shows the revoked banner for a brokered profile that was switched away from, once its background tab detects the 410", async () => {
    setProfiles([tailnetProfile, otherProfile]);
    const user = userEvent.setup();
    renderApp();

    // Open a real chat tab on the (initially active) tailnet profile and
    // send a message — proves a genuinely live, connected RelayClient exists
    // for it, same as the live scenario reported (a message got a reply).
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "oi");
    const sendButton = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(sendButton).toBeEnabled());
    await user.click(sendButton);
    expect(await screen.findByText("reply")).toBeInTheDocument();

    // Switch the sidebar to the other profile — the chat tab above must stay
    // mounted (TabBar forceMount) and its RelayClient must keep running.
    await user.click(await screen.findByRole("button", { name: en.shell.profiles.activeProfile }));
    await user.click(await screen.findByRole("menuitem", { name: /Trabalho/ }));
    expect(await screen.findByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Trabalho");

    // Simulate the dashboard revocation + the active-cutoff mechanism
    // closing the TCP connection: the device is now revoked, and the chat
    // tab's socket (identifiable by `?session=`, as connectToken.test.tsx
    // does) gets cut.
    revoked = true;
    const chatSocket = sockets.find((s) => s.url.includes("?session="));
    expect(chatSocket).toBeDefined();
    chatSocket!.close();

    // The banner must appear for the revoked (now non-active) profile
    // without switching back to it.
    await vi.waitFor(
      () => {
        // The eyebrow rather than the body sentence: the body names the
        // profile in its own element, so it is not one matchable string.
        expect(within(document.body).getByText(en.shell.revoked.eyebrow)).toBeInTheDocument();
        expect(within(document.body).getByText("Sandbox", { exact: false })).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Trabalho");
  });
});
