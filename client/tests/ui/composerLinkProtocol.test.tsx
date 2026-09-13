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

describe("composer autolink protocol requirement", () => {
  it("does not autolink a bare domain-shaped word typed without a scheme", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);

    // linkifyjs treats `.md` as a registered TLD (Moldova), so without
    // Composer.tsx's `shouldAutoLink` override this filename gets autolinked
    // to `http://test.md` on nothing more than sharing an extension with a
    // country-code domain.
    await user.type(composer, "please check test.md ");

    expect(composer.querySelector("a.composer-link")).toBeNull();
    expect(composer).toHaveTextContent("please check test.md");
  });

  it("still autolinks a URL typed with an explicit scheme", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);

    await user.type(composer, "see https://github.com/coder/xum ");

    const link = composer.querySelector("a.composer-link");
    expect(link).not.toBeNull();
    expect(link).toHaveTextContent("https://github.com/coder/xum");
  });
});
