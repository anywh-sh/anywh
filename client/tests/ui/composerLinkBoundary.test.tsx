import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same Tauri-API shims as sendMessage.test.tsx — required to get the
// composer to mount at all under happy-dom (see that file's comment).
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("ok");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("composer paste-link boundary", () => {
  it("stops the link mark at the pasted URL instead of absorbing the space and text typed after it", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);

    // Reproduces the reported flow exactly: paste a bare URL (linkOnPaste
    // turns it into a link mark, cursor lands right after it), then keep
    // typing with no selection/caret move in between — no → press to step
    // past the mark's right edge first. `@tiptap/extension-link`'s
    // `inclusive()` defaults to `this.options.autolink` (true here), so
    // without the `inclusive: false` override in Composer.tsx's
    // `ComposerLink`, the space and "plain text" below would land inside the
    // link mark too instead of ending it.
    await user.click(composer);
    await user.paste("https://github.com/coder/xum");
    await user.type(composer, " plain text");

    const link = composer.querySelector("a.composer-link");
    expect(link).not.toBeNull();
    expect(link).toHaveTextContent("https://github.com/coder/xum");
    expect(link?.textContent).not.toContain("plain text");
    expect(composer).toHaveTextContent("plain text");
  });
});
