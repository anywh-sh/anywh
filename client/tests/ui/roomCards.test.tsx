import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { RoomAgent } from "@/lib/relay/roomClient";

// Same Tauri seams as newRoom.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const catalogs = { claude: { options: [{ id: "opus", label: "Opus 4.6" }], defaultId: "opus" } };

function agent(over: Partial<RoomAgent>): RoomAgent {
  return { agentId: "room-1", role: "principal", title: "Profile page", runtime: "claude", model: "opus", createdBy: "user", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay("unused", { agentId: "claude", catalogs });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string }) => {
      const path = new URL(url).pathname;
      const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path === "/rooms" && init?.method === "POST") return json({ roomId: "room-1" }, 201);
      if (path === "/rooms/room-1/canvas") return json({ canvas: { positions: {}, areas: [], texts: [] } });
      if (path === "/rooms/room-1/context") return json({ dir: "/x", items: [], index: "" });
      if (path === "/sessions") return json({ sessions: [] });
      if (path === "/sessions/delete") return json({ ok: true });
      return Promise.reject(new Error(`fetch not scripted: ${path}`));
    }),
  );
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  relay.uninstall();
});

const socketOf = (session: string) => relay.sockets.find((s) => s.url.includes(`session=${session}`));

describe("room cards in the room panel", () => {
  it("opens the reporting agent's chat in the right-hand panel from a digest card", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const group = await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    await user.click(within(group).getByRole("radio", { name: en.sala.newSession.room }));
    const composer = await screen.findByLabelText(en.chat.composer.placeholder);
    await user.type(composer, "Redo the profile page");
    const send = await screen.findByRole("button", { name: en.common.send });
    await vi.waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    await vi.waitFor(() => expect(relay.sockets.some((s) => s.url.includes("/rooms/room-1/watch"))).toBe(true));
    const summary = { counts: { working: 1, awaiting_user: 0, queued: 0, waiting: 0, done: 1, blocked: 0, failed: 0, stopped: 0 }, needsYou: 0, live: 1, liveLimit: 10 };
    relay.emit({ type: "room_snapshot", roomId: "room-1", agents: [agent({}), agent({ agentId: "worker-1", role: "worker", parentId: "room-1", title: "Stop the spinner", state: "done" })], summary });

    // The principal's card opens its conversation in the side panel.
    await user.click(await screen.findByRole("button", { name: /Orchestrator, Running/ }));
    await vi.waitFor(() => expect(socketOf("room-1")).toBeDefined());
    socketOf("room-1")!.emitMessage({
      type: "agent_event",
      event: {
        type: "user_message",
        text: "Agents reported back",
        synthetic: "room_digest",
        room: { kind: "reports", reports: [{ agentId: "worker-1", title: "Stop the spinner", status: "done", at: Date.now() }] },
      },
    });

    await user.click(await screen.findByRole("button", { name: /Open Stop the spinner/ }));
    await vi.waitFor(() => expect(socketOf("worker-1")).toBeDefined());
    expect(document.querySelector('aside[data-panel="agent"]')).not.toBeNull();
  }, 20_000);
});
