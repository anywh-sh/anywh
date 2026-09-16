import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same Tauri-API guards as sendMessage.test.tsx — see its comment for why
// these two calls are unreachable outside a real Tauri shell.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("a pending `present_choice` prompt", () => {
  it("collapses to a reopenable indicator through the real ChatPanel/useRelayClient wiring, keeping the selection made before collapsing", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    // Gates the fake relay's `open`/`caught_up` handshake having landed —
    // same reasoning as sendMessage.test.tsx's wait on the send button.
    await screen.findByLabelText(en.chat.composer.placeholder);

    // Two sockets exist by this point — the sidebar's initial empty session
    // and the one "new conversation" just opened — and only the tab actually
    // on screen has a mounted `ChatPanel` to react. Broadcasting to every
    // socket is simpler than guessing which index is the live tab, and
    // harmless: `useRelayClient` instances not currently rendering a
    // `ChoiceCard` just update state nothing reads.
    for (const socket of relay.sockets) {
      socket.emitMessage({
        type: "choice_prompt",
        promptId: "p1",
        questions: [{ question: "Where to store session state?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
        kind: "choice",
      });
    }

    await user.click(await screen.findByText("Postgres"));
    await user.click(screen.getByRole("button", { name: en.chat.choice.collapse }));

    expect(screen.queryByText("Postgres")).toBeNull();
    expect(await screen.findByText(en.chat.choice.pending)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.chat.choice.reopen }));

    expect(await screen.findByText("Postgres")).toBeInTheDocument();
    expect(screen.getByText(en.chat.choice.selectedCount.replace("{count}", "1"))).toBeInTheDocument();
  });
});
