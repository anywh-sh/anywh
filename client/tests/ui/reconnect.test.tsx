import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { HistoryPageMessage } from "@/lib/relay/relay-types";
import type { AgentEvent } from "@/lib/relay/relay-types";

// Same Tauri-API guards as sendMessage.test.tsx — see its comment.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

/** One finished turn as the relay's history carries it. */
function turn(question: string, answer: string): AgentEvent[] {
  return [
    { type: "turn_started" },
    { type: "user_message", text: question },
    { type: "text", text: answer },
    { type: "turn_ended", stopped: false },
  ];
}
const page = (events: AgentEvent[], cursor: number, hasMore: boolean): HistoryPageMessage => ({
  messages: events.map((event) => ({ type: "agent_event" as const, event })),
  cursor,
  hasMore,
});

const OLDER = page(turn("question A", "answer A"), 0, false);
const TAIL = page(turn("question C", "answer C"), 2, true);
const RECONNECT_TIMEOUT = { timeout: 4000 };

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("reply", { history: { tail: TAIL, older: { 2: OLDER } } });
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** Opens a conversation whose tail is already on screen. */
async function openConversation(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByText("answer C");
  return user;
}

/** The link drops and the relay stays unreachable until `releaseConnections`. */
async function dropAndHold(): Promise<void> {
  relay.history.holdConnections = true;
  relay.dropConnections();
  await waitFor(() => expect(statusLine()).not.toBeNull());
}

/** The composer's reconnecting line (the same words also label the tab and the status bar). */
const statusLine = () => document.querySelector("[data-connection-status]");
/** happy-dom has no layout: give the scroller a height to scroll in, then put it at the top. */
function scrollToTop(scroller: HTMLElement): void {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
}
/** Only a connection that is open can carry a message. */
const openSockets = () => relay.chatSockets().filter((socket) => socket.readyState === 1);
const skeleton = () => screen.queryByRole("status", { name: en.chat.log.loading });
const count = (text: string) => screen.queryAllByText(text).length;

describe("a dropped connection", () => {
  it("keeps the conversation on screen and never shows the skeleton again", async () => {
    await openConversation();
    await dropAndHold();

    expect(screen.getByText("question C")).toBeInTheDocument();
    expect(screen.getByText("answer C")).toBeInTheDocument();
    expect(skeleton()).toBeNull();

    // Every retry of a long outage goes through the same path.
    await waitFor(() => expect(relay.chatSockets().filter((socket) => socket.readyState === 0).length).toBeGreaterThan(0), RECONNECT_TIMEOUT);
    expect(skeleton()).toBeNull();
    expect(screen.getByText("answer C")).toBeInTheDocument();
  });

  it("blocks sending, editing and answering a choice, while typing still works", async () => {
    const user = await openConversation();
    for (const socket of openSockets()) {
      socket.emitMessage({
        type: "choice_prompt",
        promptId: "p1",
        questions: [{ question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
        kind: "choice",
      });
    }
    await screen.findByText("Which store?");
    await dropAndHold();
    const sentBefore = relay.sent.length;

    // Typing is allowed; the send button says why it won't send.
    const composer = screen.getByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "typed while offline");
    expect(screen.getByRole("button", { name: en.chat.connection.sendBlocked })).toBeDisabled();
    await user.keyboard("{Enter}");

    // A pending choice can be read, not answered.
    expect(screen.getByRole("button", { name: en.chat.choice.submit })).toBeDisabled();

    // An inline edit opens, but saving waits.
    await user.click(screen.getAllByRole("button", { name: en.chat.message.edit })[0]);
    await user.type(screen.getByDisplayValue("question C"), "{Enter}");
    expect(screen.getAllByText(en.chat.connection.sendBlocked).length).toBeGreaterThan(0);

    expect(relay.sent.slice(sentBefore).filter((entry) => ["user_message", "edit_message", "choice_answer"].includes(String(entry.message.type)))).toEqual([]);
  });

  it("blocks stopping a turn that was running when the link dropped", async () => {
    const user = await openConversation();
    for (const socket of openSockets()) socket.emitMessage({ type: "turn_state", active: true, startedAt: Date.now() });
    const stop = await screen.findByRole("button", { name: en.common.stop });
    await dropAndHold();
    const sentBefore = relay.sent.length;

    expect(stop).toBeDisabled();
    await user.click(stop);
    expect(relay.sent.slice(sentBefore).filter((entry) => entry.message.type === "stop_turn")).toEqual([]);
  });

  it("shows a turn the tail gained meanwhile, without duplicating anything", async () => {
    await openConversation();
    await dropAndHold();
    relay.history.tail = page([...turn("question C", "answer C"), ...turn("question D", "answer D")], 2, true);
    relay.releaseConnections();

    expect(await screen.findByText("answer D", undefined, RECONNECT_TIMEOUT)).toBeInTheDocument();
    expect(count("question C")).toBe(1);
    expect(count("answer C")).toBe(1);
    expect(count("question D")).toBe(1);
    expect(skeleton()).toBeNull();
  });

  it("brings back the older history that was loaded before the drop", async () => {
    await openConversation();
    relay.emit({ type: "older_history", ...OLDER });
    await screen.findByText("answer A");

    await dropAndHold();
    expect(screen.getByText("answer A")).toBeInTheDocument();

    relay.releaseConnections();
    await waitFor(() => expect(relay.sent.filter((entry) => entry.message.type === "load_older_history").length).toBeGreaterThan(0), RECONNECT_TIMEOUT);
    await waitFor(() => expect(statusLine()).toBeNull(), RECONNECT_TIMEOUT);

    expect(count("answer A")).toBe(1);
    expect(count("answer C")).toBe(1);
  });

  it("waits for the relay when scrolled to the top offline, then loads the older turns", async () => {
    await openConversation();
    await dropAndHold();

    const scroller = document.querySelector(".selectable-content");
    expect(scroller).not.toBeNull();
    scrollToTop(scroller as HTMLElement);
    expect(await screen.findByText(en.chat.connection.waitingForOlder)).toBeInTheDocument();
    expect(relay.sent.filter((entry) => entry.message.type === "load_older_history")).toEqual([]);

    relay.releaseConnections();
    expect(await screen.findByText("answer A", undefined, RECONNECT_TIMEOUT)).toBeInTheDocument();
    expect(screen.queryByText(en.chat.connection.waitingForOlder)).toBeNull();
  });

  it("shows a live event that arrives during the resync exactly once", async () => {
    await openConversation();
    relay.emit({ type: "older_history", ...OLDER });
    await screen.findByText("answer A");

    await dropAndHold();
    relay.history.holdOlder = true;
    relay.releaseConnections();
    await waitFor(() => expect(relay.sent.filter((entry) => entry.message.type === "load_older_history").length).toBeGreaterThan(0), RECONNECT_TIMEOUT);

    // The resync is waiting on the older page: the live text is held back.
    for (const socket of openSockets()) socket.emitMessage({ type: "agent_event", event: { type: "text", text: "arrived mid-resync" } });
    expect(screen.queryByText("arrived mid-resync")).toBeNull();

    relay.releaseOlder();
    expect(await screen.findByText("arrived mid-resync")).toBeInTheDocument();
    expect(count("arrived mid-resync")).toBe(1);
    expect(count("answer A")).toBe(1);
    expect(count("answer C")).toBe(1);
  });
});
