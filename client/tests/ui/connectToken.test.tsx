import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles } from "@/lib/profiles/profiles";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

// Same Tauri-API guards as sendMessage.test.tsx — this tier renders the same
// ChatPanel/composer path to reach the point where RelayClient opens its
// WebSocket.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  relay = installFakeRelay();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("Profile.connectToken", () => {
  it("is sent as a `token` query param on the relay WebSocket URL", async () => {
    setProfiles([
      { id: "paired", label: "Paired device", host: "1.2.3.4", relayPort: 8443, connectToken: "s3cr3t" },
    ]);

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));

    // `/sessions/watch` (useSessionNames) opens its own socket independent of
    // RelayClient — filter to the session socket RelayClient.connect opens.
    await vi.waitFor(() => expect(relay.sockets.some((s) => s.url.includes("?session="))).toBe(true));
    const sessionSocket = relay.sockets.find((s) => s.url.includes("?session="))!;
    expect(sessionSocket.url).toContain("token=s3cr3t");
  });

  it("omits the `token` query param entirely when the profile has none", async () => {
    setProfiles([{ id: "unpaired", label: "Self-hosted", host: "1.2.3.4", relayPort: 8443 }]);

    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));

    await vi.waitFor(() => expect(relay.sockets.some((s) => s.url.includes("?session="))).toBe(true));
    const sessionSocket = relay.sockets.find((s) => s.url.includes("?session="))!;
    expect(sessionSocket.url).not.toContain("token=");
  });
});
