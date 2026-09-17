import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// ChatPanel registers a drag-drop listener unconditionally on mount
// (client/src/components/chat/ChatPanel.tsx) via getCurrentWebview(), which
// reads window.__TAURI_INTERNALS__ synchronously — absent outside a real
// Tauri shell, so it throws before this tier's tests get anywhere near the
// composer. Every other Tauri API call reachable during this flow is already
// guarded behind inTauri() checks — except useVoiceRecording's mic-device
// probe (client/src/hooks/media/useVoiceRecording.ts), which isn't guarded but
// already tolerates rejection (console.error, empty device list) even in a
// plain, non-Tauri browser tab today. Mocked here too, purely to keep test
// output free of an expected-and-harmless error.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("Hi, how can I help?");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("sending a message", () => {
  it("renders the user's message and the streamed reply", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));

    // Tiptap's editable div is a bare `[contenteditable]` with no explicit
    // `role="textbox"` (confirmed in the rendered DOM) — dom-testing-library
    // doesn't infer the implicit ARIA role for it, so `findByRole("textbox")`
    // never resolves. `findByLabelText` matches the same `aria-label`
    // without depending on that role mapping.
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "hello there");

    // The send button only enables once BOTH the composer is non-empty and
    // the fake relay's `open` event has landed (RelayClient.connect ->
    // onConnectionChange) — same two gates a real user hits.
    const sendButton = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(sendButton).toBeEnabled());
    await user.click(sendButton);

    expect(await screen.findByText("hello there")).toBeInTheDocument();
    expect(await screen.findByText("Hi, how can I help?")).toBeInTheDocument();
  });
});
