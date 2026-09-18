import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same Tauri shims as sendMessage.test.tsx — ChatPanel calls getCurrentWebview()
// unconditionally on mount, which throws outside a real Tauri shell.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("fake reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

// The files/terminal toggles live in the tab group strip, next to its `+`
// (portaled there by the active tab's own ChatPanel — see panelTogglesSlot.ts),
// but the gate that gets them there is still `cwd`: it arrives on the tab's
// own socket as `cwd_state`, same as a real relay, and nothing renders the
// pair as usable before that lands — there is no folder yet to open a
// terminal in or list files from.
describe("files/terminal toggles — cwd gate", () => {
  it("stays disabled until the session's cwd arrives, then enables", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    await screen.findByLabelText(en.chat.composer.placeholder);

    const filesToggle = await screen.findByLabelText(en.panels.openFiles);
    const terminalToggle = await screen.findByLabelText(en.panels.openTerminal);
    expect(filesToggle).toBeDisabled();
    expect(terminalToggle).toBeDisabled();

    relay.sockets[relay.sockets.length - 1].emitMessage({ type: "cwd_state", cwd: "/home/user/project", locked: false });

    await vi.waitFor(() => expect(screen.getByLabelText(en.panels.openFiles)).toBeEnabled());
    expect(screen.getByLabelText(en.panels.openTerminal)).toBeEnabled();
  });

  it("clicking the enabled toggle opens its pane", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    await screen.findByLabelText(en.chat.composer.placeholder);
    relay.sockets[relay.sockets.length - 1].emitMessage({ type: "cwd_state", cwd: "/home/user/project", locked: false });
    await vi.waitFor(() => expect(screen.getByLabelText(en.panels.openFiles)).toBeEnabled());

    await user.click(screen.getByLabelText(en.panels.openFiles));

    expect(await screen.findByLabelText(en.panels.closeFiles)).toBeInTheDocument();
  });
});
