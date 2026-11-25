import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same reasons as sendMessage.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const agent = en.chat.composer.agentNames.claude;
const turnFailed = en.chat.agentSignedOut.turnFailed.split("{agent}").join(agent);
const reconnect = en.chat.agentSignedOut.reconnect.split("{agent}").join(agent);

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("ok", { agentId: "claude" });
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("a live turn that failed for a lost login", () => {
  // What a signed-out claude sends on a fresh machine: its message once as
  // the reply, then again as the turn's error, tagged `auth` by the relay.
  it("says so in the app's words, once, with Connect", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    await vi.waitFor(() => expect(relay.chatSockets().length).toBeGreaterThan(0));

    relay.emit({ type: "agent_event", event: { type: "text", text: "Not logged in · Please run /login" } });
    relay.emit({ type: "agent_event", event: { type: "error", message: "Not logged in · Please run /login", failureClass: "auth" } });

    expect(await screen.findByText(turnFailed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: reconnect })).toBeInTheDocument();
    expect(screen.queryByText(/Please run \/login/)).not.toBeInTheDocument();
  });
});
