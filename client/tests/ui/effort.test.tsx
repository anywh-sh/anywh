import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same mocks as sendMessage.test.tsx — see the comment there.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

let relay: FakeRelay;

// Claude 2.1.289's shape: levels per model, no default; Haiku takes none.
const CLAUDE_CATALOGS = {
  claude: {
    options: [
      { id: "opus", label: "Opus 5.5", efforts: [{ id: "low" }, { id: "high" }, { id: "max" }] },
      { id: "haiku", label: "Haiku 4.5" },
    ],
    defaultId: "opus",
  },
};

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("fake relay reply", { agentId: "claude", catalogs: CLAUDE_CATALOGS });
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function openConversation() {
  renderApp();
  await userEvent.setup().click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  return screen.findByRole("button", { name: en.chat.composer.effortAriaLabel });
}

describe("reasoning effort in the composer", () => {
  it("picking a level from the dropdown sends set_effort, and Default sends null", async () => {
    const user = userEvent.setup();
    const trigger = await openConversation();
    await vi.waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveTextContent(en.chat.composer.effortDefault);

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(relay.sent).toContainEqual({ type: "set_effort", effort: "high" });

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: en.chat.composer.effortDefault }));
    const picks = relay.sent.filter((m) => m.type === "set_effort");
    expect(picks[picks.length - 1]).toEqual({ type: "set_effort", effort: null });
  });

  it("reflects the relay's effort_state in the trigger", async () => {
    const trigger = await openConversation();
    relay.emit({ type: "effort_state", effort: "max" });
    await vi.waitFor(() => expect(trigger).toHaveTextContent("Max"));
  });

  it("/effort <level> is handled locally as set_effort, never sent as a chat message", async () => {
    const user = userEvent.setup();
    await openConversation();
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "/effort high");
    const sendButton = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(sendButton).toBeEnabled());
    await user.type(composer, "{Enter}");

    await vi.waitFor(() => expect(relay.sent).toContainEqual({ type: "set_effort", effort: "high" }));
    expect(relay.sent.some((m) => m.type === "user_message")).toBe(false);
  });

  it("is hidden for a model with no efforts", async () => {
    const trigger = await openConversation();
    await vi.waitFor(() => expect(trigger).toBeEnabled());
    relay.emit({ type: "model_state", model: "haiku" });
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: en.chat.composer.effortAriaLabel })).toBeNull());
  });

  it("a new conversation resumes the last-used effort", async () => {
    cleanup();
    relay.uninstall();
    localStorage.setItem("anywh:last-effort", JSON.stringify({ "default:claude": "max" }));
    relay = installFakeRelay("fake relay reply", { agentId: "claude", catalogs: CLAUDE_CATALOGS });
    await openConversation();
    await vi.waitFor(() => expect(relay.sent).toContainEqual({ type: "set_effort", effort: "max" }));
  });

  it("doesn't resume a last-used effort the model doesn't list", async () => {
    cleanup();
    relay.uninstall();
    localStorage.setItem("anywh:last-effort", JSON.stringify({ "default:claude": "xhigh" }));
    relay = installFakeRelay("fake relay reply", { agentId: "claude", catalogs: CLAUDE_CATALOGS });
    const trigger = await openConversation();
    await vi.waitFor(() => expect(trigger).toBeEnabled());
    expect(relay.sent.some((m) => m.type === "set_effort")).toBe(false);
  });
});
