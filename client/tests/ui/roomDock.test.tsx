import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { RoomAgent } from "@/lib/relay/roomClient";

// Same Tauri seams as roomCards.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

const catalogs = { claude: { options: [{ id: "opus", label: "Opus 4.6" }], defaultId: "opus" } };
const summary = { counts: { working: 1, awaiting_user: 0, queued: 0, waiting: 0, done: 1, blocked: 0, failed: 0, stopped: 0 }, needsYou: 0, live: 1, liveLimit: 10 };

function agent(over: Partial<RoomAgent>): RoomAgent {
  return { agentId: "room-1", role: "principal", title: "Profile page", runtime: "claude", model: "opus", createdBy: "user", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}
const principal = agent({});
const worker = agent({ agentId: "worker-1", role: "worker", parentId: "room-1", title: "Stop the spinner", state: "done" });

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
      if (path === "/rooms/room-1") return json({ members: [] });
      if (path === "/rooms/room-1/worktrees") return json({ worktrees: [], totalSizeBytes: 0 });
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

const socketsOf = (session: string) => relay.sockets.filter((s) => s.url.includes(`session=${session}`));
const pane = (kind: string) => document.querySelector<HTMLElement>(`[data-dock-pane="${kind}"]`);
const panelKinds = () => [...document.querySelectorAll("[data-dock-pane]")].map((el) => el.getAttribute("data-dock-pane"));

/** A room with an orchestrator and one finished worker, opened in a tab. */
async function openRoom(agents: RoomAgent[] = [principal, worker]) {
  const user = userEvent.setup();
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  const group = await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
  await user.click(within(group).getByRole("radio", { name: en.sala.newSession.room }));
  await user.type(await screen.findByLabelText(en.chat.composer.placeholder), "Redo the profile page");
  const send = await screen.findByRole("button", { name: en.common.send });
  await vi.waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await vi.waitFor(() => expect(relay.sockets.some((s) => s.url.includes("/rooms/room-1/watch"))).toBe(true));
  act(() => relay.emit({ type: "room_snapshot", roomId: "room-1", agents, summary }));
  return user;
}

const openOrchestrator = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /Orchestrator, Running/ }));
// The strip's button, which is there once the side panel shows (the floating one on the canvas only exists where there is no dock).
const aboutButton = () => screen.findByRole("button", { name: en.panels.openRoomAbout });

describe("a room's panes in the session dock", () => {
  it("opens the orchestrator's conversation as a pane of the dock, not a panel of the room", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await vi.waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="principal"]')).not.toBeNull());
    expect(document.querySelector(".sala-side")).toBeNull();
  }, 20_000);

  it("keeps the conversation over a single connection when it is opened again for another agent", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await vi.waitFor(() => expect(socketsOf("room-1")).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: /Stop the spinner/ }));
    expect(socketsOf("room-1")).toHaveLength(1);
  }, 20_000);

  it("switches to the room's information when it is opened over a conversation", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await user.click(await aboutButton());
    await vi.waitFor(() => expect(panelKinds()).toEqual(["about"]));
  }, 20_000);

  it("switches to the terminal when it is opened over the room's information", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await user.click(await aboutButton());
    await vi.waitFor(() => expect(panelKinds()).toEqual(["about"]));
    await user.click(screen.getByRole("button", { name: en.panels.openTerminal }));
    await vi.waitFor(() => expect(panelKinds()).toEqual(["terminal"]));
  }, 20_000);

  it("falls back to the empty state on Esc", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await user.click(await aboutButton());
    await vi.waitFor(() => expect(panelKinds()).toEqual(["about"]));
    await user.keyboard("{Escape}");
    // The panel stays open, on its no-selection view.
    await vi.waitFor(() => expect(panelKinds()).toEqual(["none"]));
  }, 20_000);

  it("brings the panes back when the side panel is hidden and shown again", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await vi.waitFor(() => expect(panelKinds()).toEqual(["agent"]));
    await user.click(screen.getByRole("button", { name: en.panels.hideRightPanel }));
    // The dock keeps what it showed mounted while closed; what says it is
    // closed is the toggle, and the width it is drawn with.
    const dockWidth = () => (pane("agent")?.closest('div[style*="contain"]') as HTMLElement | null)?.style.width;
    await vi.waitFor(() => expect(dockWidth()).toBe("0px"));
    await user.click(screen.getByRole("button", { name: en.panels.showRightPanel }));
    await vi.waitFor(() => expect(dockWidth()).not.toBe("0px"));
    expect(panelKinds()).toEqual(["agent"]);
  }, 20_000);

  it("opens the agent pane on the orchestrator from the side panel toggle of a room with nothing open", async () => {
    const user = await openRoom();
    await user.click(screen.getByRole("button", { name: en.panels.showRightPanel }));
    await vi.waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="principal"]')).not.toBeNull());
  }, 20_000);

  it("falls back to the orchestrator when the agent being shown is removed", async () => {
    const user = await openRoom();
    await user.click(await screen.findByRole("button", { name: /Stop the spinner/ }));
    await vi.waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="agent"]')).not.toBeNull());
    act(() => relay.emit({ type: "room_snapshot", roomId: "room-1", agents: [principal], summary }));
    await vi.waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="principal"]')).not.toBeNull());
  }, 20_000);

  it("keeps the conversation's connection when the room's tab goes to the background and comes back", async () => {
    const user = await openRoom();
    await openOrchestrator(user);
    await vi.waitFor(() => expect(socketsOf("room-1")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: en.shell.sidebar.newConversation }));
    await screen.findByRole("radiogroup", { name: en.sala.newSession.modeLabel });
    // Still there, behind the new tab, with its connection.
    expect(pane("agent")?.querySelector('aside[data-panel="principal"]')).not.toBeNull();
    await user.click(screen.getByRole("tab", { name: /Profile page/ }));
    expect(socketsOf("room-1")).toHaveLength(1);
    expect(pane("agent")?.querySelector('aside[data-panel="principal"]')).not.toBeNull();
  }, 20_000);
});
