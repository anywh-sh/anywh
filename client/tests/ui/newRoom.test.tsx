import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { RoomAgent } from "@/lib/relay/roomClient";

// Same two Tauri seams as sendMessage.test.tsx: a drag-drop listener ChatPanel
// registers on mount and the mic-device probe.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const catalogs = { claude: { options: [{ id: "opus", label: "Opus 4.6" }], defaultId: "opus" } };

function principal(over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId: "room-1", role: "principal", title: "Profile page", runtime: "claude", model: "opus", createdBy: "user", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, ...over };
}

let relay: FakeRelay;
let rooms: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("unused", { agentId: "claude", catalogs });
  rooms = [];
  // The HTTP surface of a room, as the relay answers it.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const path = new URL(url).pathname;
      rooms.push({ url: path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path === "/rooms" && init?.method === "POST") return json({ roomId: "room-1" }, 201);
      if (path === "/rooms/room-1/canvas") return json({ canvas: { positions: {}, areas: [], texts: [] } });
      if (path === "/rooms/room-1/context") return json({ dir: "/x", items: [{ name: "a.md" }, { name: "b.md" }], index: "" });
      if (path === "/sessions/delete") return json({ ok: true });
      return Promise.reject(new Error(`fetch not scripted: ${path}`));
    }),
  );
});

afterEach(async () => {
  cleanup();
  // Unmounting a room writes its layout back; let that request leave while
  // `fetch` is still the fake one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  relay.uninstall();
});

const composerOf = (root: Document): HTMLElement => root.querySelector<HTMLElement>(".composer-editor .ProseMirror")!;

async function openNewSession(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
}

describe("a new session in room mode", () => {
  it("offers Conversation and Room, and the room's composer asks for a demand", async () => {
    const user = userEvent.setup();
    renderApp();
    await openNewSession(user);

    const group = await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    expect(within(group).getByRole("radio", { name: en.sala.newSession.conversation })).toBeChecked();
    expect(await screen.findByLabelText(en.chat.composer.placeholder)).toBeInTheDocument();

    await user.click(within(group).getByRole("radio", { name: en.sala.newSession.room }));
    expect(within(group).getByRole("radio", { name: en.sala.newSession.room })).toBeChecked();
    expect(within(group).getByRole("radio", { name: en.sala.newSession.conversation })).not.toBeChecked();
    expect(document.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")).toBe(en.sala.newSession.placeholderRoom);
  });

  it("opens the room on the picked agent and model, turns the tab into its canvas, and sends the message along with it", async () => {
    const user = userEvent.setup();
    renderApp();
    await openNewSession(user);
    const group = await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    await user.click(within(group).getByRole("radio", { name: en.sala.newSession.room }));

    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "Redo the profile page");
    const send = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    await vi.waitFor(() => expect(rooms.find((r) => r.url === "/rooms" && r.method === "POST")).toBeDefined());
    const created = rooms.find((r) => r.url === "/rooms")!.body as Record<string, unknown>;
    expect(created.agentId).toBe("claude");
    expect(created.title).toBe("Redo the profile page");
    // The message travels with the room, so no second socket has to deliver it.
    expect(created.firstMessage).toBe("Redo the profile page");

    // The same tab is now the room, not the conversation: nothing to draw yet.
    expect(await screen.findByText(en.sala.canvas.loading)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: en.sala.newSession.modeLabel })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(within(screen.getByRole("tab")).getByRole("img", { name: en.sala.roomGlyph })).toBeInTheDocument();

    // The blank session the new tab had opened on the relay is dropped: it is not the room.
    await vi.waitFor(() => expect(rooms.find((r) => r.url === "/sessions/delete" && r.method === "POST")).toBeDefined());
    expect((rooms.find((r) => r.url === "/sessions/delete")!.body as { id: string }).id).not.toBe("room-1");

    expect(relay.sent.some((s) => s.url.includes("session=room-1") && s.message.type === "user_message")).toBe(false);

    // The room's channel is opened for the room, and what it says is drawn.
    await vi.waitFor(() => expect(relay.sockets.some((s) => s.url.includes("/rooms/room-1/watch"))).toBe(true));
    const summary = { counts: { working: 1, awaiting_user: 0, queued: 0, waiting: 0, done: 0, blocked: 0, failed: 0, stopped: 0 }, needsYou: 0, live: 1, liveLimit: 10 };
    relay.emit({ type: "room_snapshot", roomId: "room-1", agents: [principal()], summary });
    expect(await screen.findByTestId("sala-canvas")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Profile page, Running/ })).toBeInTheDocument();
  });

  it("does not offer Room on a session that has had a turn, even when its log is empty again (/clear)", async () => {
    const user = userEvent.setup();
    renderApp();
    await openNewSession(user);
    await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    // The relay locks a conversation's folder with its first turn.
    relay.emit({ type: "cwd_state", cwd: "/work", locked: true });
    await vi.waitFor(() => expect(screen.queryByRole("radiogroup", { name: en.sala.newSession.modeLabel })).not.toBeInTheDocument());
  });

  it("keeps the session a conversation when Conversation is chosen: no room is opened", async () => {
    const user = userEvent.setup();
    renderApp();
    await openNewSession(user);
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "just a chat");
    const send = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await vi.waitFor(() => expect(relay.sent.some((s) => s.message.type === "user_message")).toBe(true));
    expect(rooms.some((r) => r.method === "POST" && r.url === "/rooms")).toBe(false);
    expect(screen.queryByTestId("sala-canvas")).not.toBeInTheDocument();
  });

  it("says so, and stays on the new-session screen, when the room cannot be opened", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 400 }))));
    // happy-dom has no `alert`; the app uses it for failures it cannot show elsewhere.
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    const user = userEvent.setup();
    renderApp();
    await openNewSession(user);
    const group = await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    await user.click(within(group).getByRole("radio", { name: en.sala.newSession.room }));
    await user.type(await screen.findByLabelText(en.chat.composer.placeholder), "x");
    const send = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(en.sala.newSession.createFailed));
    // What was typed is back in the composer, not lost with the failure.
    await vi.waitFor(() => expect(composerOf(document).textContent).toContain("x"));
    expect(screen.queryByTestId("sala-canvas")).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: en.sala.newSession.modeLabel })).toBeInTheDocument();
  });
});
