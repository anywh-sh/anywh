import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// The iOS shell: the chat reads no plan usage there, so whether the agent
// is signed in comes from the relay's agent list (`GET /control/agents`).
vi.mock("@/lib/platform/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/platform")>()),
  isIOS: () => true,
}));
// Same reasons as sendMessage.test.tsx; the native composer's plugin calls
// go through `invoke` too, and only need to resolve.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
// iOS opens a conversation from the native top bar: its plugin events are
// kept here, so a test can fire one the way the native side does.
const pluginListeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve([]),
  addPluginListener: (_plugin: string, event: string, handler: (event: unknown) => void) => {
    pluginListeners.set(event, handler);
    return Promise.resolve({ unregister: () => Promise.resolve() });
  },
  Channel: class {},
}));

const agent = en.chat.composer.agentNames.claude;
const strip = en.chat.agentSignedOut.message.split("{agent}").join(agent);
const turnFailed = en.chat.agentSignedOut.turnFailed.split("{agent}").join(agent);
const reconnect = en.chat.agentSignedOut.reconnect.split("{agent}").join(agent);

let relay: FakeRelay;

function relayWithClaude(loggedIn: boolean): FakeRelay {
  return installFakeRelay("ok", {
    agentId: "claude",
    control: { agents: [{ id: "claude", installed: true, version: "2.1.330", loggedIn, signIn: true }] },
  });
}

beforeEach(() => {
  localStorage.clear();
  pluginListeners.clear();
  seedShellProfile();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function openConversation(): Promise<void> {
  renderApp();
  await vi.waitFor(() => expect(pluginListeners.has("topBarNewConversation")).toBe(true));
  act(() => pluginListeners.get("topBarNewConversation")?.(undefined));
}

describe("signing the agent in from the chat on iOS", () => {
  it("shows the strip with Connect when the relay's agent list says the agent has no login", async () => {
    relay = relayWithClaude(false);
    await openConversation();

    const row = (await screen.findByText(strip)).closest("[data-agent-signed-out]");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: en.chat.agentSignedOut.connect })).toBeInTheDocument();
  });

  it("shows no strip when the agent is signed in", async () => {
    relay = relayWithClaude(true);
    await openConversation();

    await vi.waitFor(() => expect(relay.agentChecks()).toBeGreaterThan(0));
    // The read has to land before its absence means anything.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(strip)).not.toBeInTheDocument();
  });

  it("a turn that failed for a lost login offers Connect and reads the login again, which brings the strip up", async () => {
    relay = relayWithClaude(true);
    await openConversation();
    await vi.waitFor(() => expect(relay.agentChecks()).toBeGreaterThan(0));
    const checksBefore = relay.agentChecks();

    // The login went away between the read and the turn.
    relay.control!.agents = [{ id: "claude", installed: true, version: "2.1.330", loggedIn: false, signIn: true }];
    relay.emit({ type: "agent_event", event: { type: "text", text: "Not logged in · Please run /login" } });
    relay.emit({ type: "agent_event", event: { type: "error", message: "Not logged in · Please run /login", failureClass: "auth" } });

    expect(await screen.findByText(turnFailed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: reconnect })).toBeInTheDocument();
    await vi.waitFor(() => expect(relay.agentChecks()).toBeGreaterThan(checksBefore));
    expect(await screen.findByText(strip)).toBeInTheDocument();
  });
});
