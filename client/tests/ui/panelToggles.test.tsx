import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same Tauri shims as sendMessage.test.tsx — ChatPanel calls getCurrentWebview()
// unconditionally on mount, which throws outside a real Tauri shell.
// `onDragDropEvent`'s result is chained with `.then` (not `await`) in
// ChatPanel.tsx, so it has to be a real thenable — `Promise.resolve` gives
// that without an `async` function that never uses `await`, which is what
// trips `@typescript-eslint/require-await` on a file with no baselined
// suppression yet (sendMessage.test.tsx's copy of this shim predates the
// baseline). `invoke`'s callers all `await` it, and `await` on a plain
// return value resolves immediately regardless, so it doesn't need the same
// treatment.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));

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

// The files/terminal toggles live in the tab group strip, next to the side
// panel's own toggle (portaled there by the active tab's own ChatPanel — see
// panelTogglesSlot.ts). They belong to the side panel: a tab with nothing
// open has no panel, and none of them. Opening the panel brings them, and the
// gate that makes them usable is still `cwd`: it arrives on the tab's own
// socket as `cwd_state`, same as a real relay, and nothing renders the pair
// as usable before that lands — there is no folder yet to open a terminal in
// or list files from.
// Opening the panel mounts the Files pane (a lazy chunk) in the same render
// the buttons appear in; with the whole suite running beside it that outlasts
// the default 1s, so every wait here says how long it is allowed to take.
const SLOW = { timeout: 5000 };

async function openConversationAndPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(en.chat.composer.placeholder);
  await user.click(await screen.findByRole("button", { name: en.panels.showRightPanel }, SLOW));
}

describe("files/terminal toggles — cwd gate", () => {
  it("has neither toggle while the side panel is closed", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    await screen.findByLabelText(en.chat.composer.placeholder);
    await screen.findByRole("button", { name: en.panels.showRightPanel }, SLOW);

    expect(screen.queryByLabelText(en.panels.openFiles)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(en.panels.openTerminal)).not.toBeInTheDocument();
  });

  it("stays disabled until the session's cwd arrives, then enables", async () => {
    const user = userEvent.setup();
    renderApp();
    await openConversationAndPanel(user);

    // A panel opened on a tab that never had a pane opens Files, so its
    // button reads "close" while the terminal's reads "open".
    const filesToggle = await screen.findByLabelText(en.panels.closeFiles, undefined, SLOW);
    const terminalToggle = await screen.findByLabelText(en.panels.openTerminal, undefined, SLOW);
    expect(filesToggle).toBeDisabled();
    expect(terminalToggle).toBeDisabled();

    relay.sockets[relay.sockets.length - 1].emitMessage({ type: "cwd_state", cwd: "/home/user/project", locked: false });

    await vi.waitFor(() => expect(screen.getByLabelText(en.panels.closeFiles)).toBeEnabled(), SLOW);
    expect(screen.getByLabelText(en.panels.openTerminal)).toBeEnabled();
  });

  it("clicking the enabled toggle opens its pane", async () => {
    const user = userEvent.setup();
    renderApp();
    await openConversationAndPanel(user);
    relay.sockets[relay.sockets.length - 1].emitMessage({ type: "cwd_state", cwd: "/home/user/project", locked: false });
    await vi.waitFor(() => expect(screen.getByLabelText(en.panels.openTerminal)).toBeEnabled(), SLOW);

    await user.click(screen.getByLabelText(en.panels.openTerminal));

    expect(await screen.findByLabelText(en.panels.closeTerminal, undefined, SLOW)).toBeInTheDocument();
  });

  it("takes the pane buttons away with the panel", async () => {
    const user = userEvent.setup();
    renderApp();
    await openConversationAndPanel(user);
    await screen.findByLabelText(en.panels.openTerminal, undefined, SLOW);

    await user.click(screen.getByRole("button", { name: en.panels.hideRightPanel }));

    expect(screen.queryByLabelText(en.panels.openTerminal)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(en.panels.closeFiles)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.panels.showRightPanel })).toBeInTheDocument();
  });
});
