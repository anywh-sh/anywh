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
  it("bots and conversations take turns: opening one folds the other to the bottom, and the choice is kept", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      // The relay lists a bot with the bots, never among the conversations.
      watch.emitMessage({ type: "session_list_snapshot", sessions: [{ id: "chat-1", title: "A conversation", lastActiveAt: Date.now() }] });
      watch.emitMessage({ type: "bots_state", bots: [vigia] });
    });

    // Conversations open: the folded Bots heading still shows that a bot
    // needs the person.
    expect(await screen.findByText("A conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vigia" })).not.toBeInTheDocument();
    const botsHeading = screen.getByRole("button", { name: new RegExp(en.bots.section) });
    expect(botsHeading).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTitle(en.bots.collapsedNeedsYou.replace("{count}", "1"))).toBeInTheDocument();

    await user.click(botsHeading);
    const row = await screen.findByRole("button", { name: "Vigia" });
    expect(row).toHaveTextContent("1 needs you");
    expect(screen.queryByText("A conversation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(en.bots.conversations) })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("anywh:sidebar-section")).toBe("bots");

    // Opening the bot opens its conversation as a tab marked as a bot, with
    // its tree (its conversation) under its row.
    await user.click(row);
    expect(await screen.findByRole("button", { name: en.bots.conversation })).toBeInTheDocument();
    await waitFor(() => {
      const tabs = JSON.parse(localStorage.getItem("anywh:tabs") ?? "[]") as { id: string; profileId: string; bot?: boolean }[];
      expect(tabs).toContainEqual(expect.objectContaining({ id: "room-vigia", profileId: SHELL_TEST_PROFILE.id, bot: true }));
    });
  });

  it("the + of the Bots heading opens the new bot dialog", async () => {
    const user = userEvent.setup();
    renderApp();
    await watchSocket();
    await user.click((await screen.findAllByRole("button", { name: en.bots.newBot }))[0]);
    expect(await screen.findByTestId("new-bot-dialog")).toBeInTheDocument();
  });
});
