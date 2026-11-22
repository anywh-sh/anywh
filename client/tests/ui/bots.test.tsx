import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile, SHELL_TEST_PROFILE } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import { resetBotsStore } from "@/lib/bots/botsStore";
import type { BotSummary } from "@/lib/bots/botTypes";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));

let relay: FakeRelay;

const vigia: BotSummary = {
  id: "vigia",
  roomId: "room-vigia",
  name: "Vigia",
  mascot: { seed: "Vigia" },
  paused: false,
  firstRun: false,
  needsYou: 1,
  working: 0,
  busy: false,
  lastRunFailed: false,
  createdAt: 1,
};

beforeEach(() => {
  localStorage.clear();
  resetBotsStore();
  seedShellProfile();
  relay = installFakeRelay("fake reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** The relay's `/sessions/watch` socket, once the app opened it. */
async function watchSocket() {
  await waitFor(() => {
    if (!relay.sockets.some((socket) => new URL(socket.url).pathname === "/sessions/watch" && socket.readyState === 1)) throw new Error("no watch yet");
  });
  return relay.sockets.find((socket) => new URL(socket.url).pathname === "/sessions/watch")!;
}

describe("bots in the sidebar", () => {
  it("bots sit above the conversations, folding on their own, and the fold is kept", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      // The relay lists a bot with the bots, never among the conversations.
      watch.emitMessage({ type: "session_list_snapshot", sessions: [{ id: "chat-1", title: "A conversation", lastActiveAt: Date.now() }] });
      watch.emitMessage({ type: "bots_state", bots: [vigia] });
    });

    // Both show at once: the bots group above the conversation groups.
    const row = await screen.findByRole("button", { name: "Vigia" });
    expect(row).toHaveTextContent("1 needs you");
    expect(await screen.findByText("A conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Conversations/ })).not.toBeInTheDocument();

    // Folded, the bots go but the heading still shows that one needs the
    // person; the conversations stay.
    const botsHeading = screen.getByRole("button", { name: new RegExp(`^${en.bots.section}`) });
    expect(botsHeading).toHaveAttribute("aria-expanded", "true");
    await user.click(botsHeading);
    expect(botsHeading).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Vigia" })).not.toBeInTheDocument();
    expect(screen.getByTitle(en.bots.collapsedNeedsYou.replace("{count}", "1"))).toBeInTheDocument();
    expect(screen.getByText("A conversation")).toBeInTheDocument();
    expect(localStorage.getItem("anywh:sidebar-bots-open")).toBe("false");
    await user.click(botsHeading);

    // Opening the bot opens its conversation as a tab marked as a bot, with
    // its tree (its conversation) under its row.
    await user.click(await screen.findByRole("button", { name: "Vigia" }));
    expect(await screen.findByRole("button", { name: en.bots.conversation })).toBeInTheDocument();
    await waitFor(() => {
      const tabs = JSON.parse(localStorage.getItem("anywh:tabs") ?? "[]") as { id: string; profileId: string; bot?: boolean }[];
      expect(tabs).toContainEqual(expect.objectContaining({ id: "room-vigia", profileId: SHELL_TEST_PROFILE.id, bot: true }));
    });
  });

  it("a bot's settings, from its row's menu, open as a tab titled with its name", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      watch.emitMessage({ type: "bots_state", bots: [vigia] });
    });
    await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("button", { name: "Vigia" }) });
    await user.click(await screen.findByRole("menuitem", { name: en.bots.menu.settings }));
    expect(await screen.findByTestId("bot-settings-view")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: new RegExp(en.bots.settings.title.replace("{name}", "Vigia")) })).toBeInTheDocument();
  });

  it("a bot that leaves the list (deleted here or elsewhere) takes its conversation and settings tabs with it", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      watch.emitMessage({ type: "bots_state", bots: [vigia] });
    });
    await user.click(await screen.findByRole("button", { name: "Vigia" }));
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Vigia" }) });
    await user.click(await screen.findByRole("menuitem", { name: en.bots.menu.settings }));
    expect(await screen.findByTestId("bot-settings-view")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    act(() => {
      watch.emitMessage({ type: "bots_state", bots: [] });
    });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
  });

  it("the + of the Bots heading opens the new bot as a tab, and opening it again focuses the same tab", async () => {
    const user = userEvent.setup();
    renderApp();
    await watchSocket();
    await user.click((await screen.findAllByRole("button", { name: en.bots.newBot }))[0]);
    expect(await screen.findByTestId("new-bot-view")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: new RegExp(en.bots.create.title) })).toBeInTheDocument();
    await user.click((await screen.findAllByRole("button", { name: en.bots.newBot }))[0]);
    expect(screen.getAllByTestId("new-bot-view")).toHaveLength(1);
  });
});
