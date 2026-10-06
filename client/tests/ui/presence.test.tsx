import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

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

const sessionOf = (url: string) => new URL(url.replace("ws://", "http://")).searchParams.get("session");
const presenceBySession = () =>
  relay.sent
    .filter((m) => m.message.type === "presence")
    .map((m) => [sessionOf(m.url), m.message.visible] as const);

// What the person is looking at decides whether the relay may push to their
// phone, so it has to be reported through the real app: the open tab claims
// to be on screen, and a tab that stops being the open one withdraws.
describe("telling the relay which conversation is on screen", () => {
  it("claims the open conversation, and withdraws it when another becomes the open one", async () => {
    const user = userEvent.setup();
    renderApp();

    const newConversation = await screen.findByRole("button", { name: en.shell.sidebar.newConversation });
    await user.click(newConversation);
    await vi.waitFor(() => expect(presenceBySession().length).toBeGreaterThan(0));
    const first = presenceBySession()[0]?.[0];
    expect(presenceBySession()).toContainEqual([first, true]);

    await user.click(newConversation);
    // Each conversation has its own socket; the new one is the second distinct session.
    const chatSessions = () => new Set(relay.sockets.map((s) => sessionOf(s.url)).filter((id) => id !== null));
    await vi.waitFor(() => expect(chatSessions().size).toBe(2));
    const second = [...chatSessions()].find((id) => id !== first);
    expect(second).toBeTruthy();

    await vi.waitFor(() => {
      const claims = presenceBySession();
      expect(claims).toContainEqual([second, true]);
      expect(claims).toContainEqual([first, false]);
    });
  });
});
