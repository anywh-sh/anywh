import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
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
  mascot: { character: "bip", tone: "areia" },
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

  it("a bot's conversation never joins the conversation list, even when its tab gets a title", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      watch.emitMessage({ type: "session_list_snapshot", sessions: [{ id: "chat-1", title: "A conversation", lastActiveAt: Date.now() }] });
      watch.emitMessage({ type: "bots_state", bots: [vigia] });
    });
    await user.click(await screen.findByRole("button", { name: "Vigia" }));
    await waitFor(() => {
      if (!relay.sockets.some((socket) => socket.url.includes("session=room-vigia") && socket.readyState === 1)) throw new Error("no bot socket yet");
    });
    // The conversation's socket, not the room channel's (`/rooms/<id>/watch`).
    const botSocket = relay.sockets.find((socket) => socket.url.includes("session=room-vigia"))!;
    act(() => {
      botSocket.emitMessage({ type: "session_title", title: "CI check" });
    });
    // The title reaches the tab, the path that used to list it; the tab wears
    // the bot's face, as its sidebar row does.
    await waitFor(() => expect(screen.getByRole("tab", { name: /CI check/ })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /CI check/ }).querySelector("[data-mascot-state]")).not.toBeNull();
    expect(screen.getByText("A conversation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^CI check/ })).not.toBeInTheDocument();
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
    const settingsTab = screen.getByRole("tab", { name: new RegExp(en.bots.settings.title.replace("{name}", "Vigia")) });
    expect(settingsTab.querySelector("[data-mascot-state]")).not.toBeNull();
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

  it("with no bot, the sidebar card's New bot opens the dialog, and Templates opens the templates tab", async () => {
    const user = userEvent.setup();
    renderApp();
    const watch = await watchSocket();
    act(() => {
      watch.emitMessage({ type: "bots_state", bots: [] });
    });
    const card = await screen.findByTestId("bots-first-card");
    await user.click(within(card).getByRole("button", { name: en.bots.firstBot.create }));
    expect(await screen.findByTestId("new-bot-dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("new-bot-dialog")).not.toBeInTheDocument());
    await user.click(within(card).getByRole("button", { name: en.bots.firstBot.templates }));
    expect(await screen.findByTestId("bot-templates-view")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: new RegExp(en.bots.templatesTab.title) })).toBeInTheDocument();
  });

  it("a template's card opens New bot filled in, and the bot made takes the templates tab's place", async () => {
    const user = userEvent.setup();
    renderApp();
    await watchSocket();
    // The relay's POST /bots, on top of the fake relay's own routes.
    const created: Record<string, unknown>[] = [];
    const relayFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: { method?: string; body?: string }) => {
      if (new URL(String(input)).pathname === "/bots" && init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        created.push(body);
        return Promise.resolve(new Response(JSON.stringify({ bot: { ...vigia, id: "new", roomId: "room-new", name: body.name, mascot: body.mascot, needsYou: 0, firstRun: true } }), { status: 201 }));
      }
      return relayFetch(input, init);
    });

    await user.click((await screen.findAllByRole("button", { name: en.bots.newBot }))[0]);
    const dialog = await screen.findByTestId("new-bot-dialog");
    await user.click(within(dialog).getByRole("button", { name: en.bots.create.fromTemplate }));
    expect(await screen.findByTestId("bot-templates-view")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("new-bot-dialog")).not.toBeInTheDocument());

    await user.click(screen.getByTestId("bot-template-pr-review"));
    expect(await screen.findByDisplayValue(en.bots.templates["pr-review"].name)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(`^${en.bots.create.create}`) }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: en.bots.templates["pr-review"].name, mascot: { character: "oculos", tone: "giz" }, templateId: "pr-review" });
    await waitFor(() => expect(screen.queryByTestId("bot-templates-view")).not.toBeInTheDocument());
    await waitFor(() => {
      const tabs = JSON.parse(localStorage.getItem("anywh:tabs") ?? "[]") as { id: string; bot?: boolean }[];
      expect(tabs.map((tab) => tab.id)).toEqual(["room-new"]);
      expect(tabs[0].bot).toBe(true);
    });
  });
});
