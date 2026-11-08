import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { IntegrationState, QueryState, RoomTicketView, TicketRow, WorkTicket } from "@/lib/integrations/model";
import type { RoomAgent, RoomSummary } from "@/lib/relay/roomClient";
import type { SessionSummary } from "@/lib/relay/relay-types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };
const LONG = 20_000;
const work = en.integrations.work;
const SITE = "cloud-1";
const catalogs = { claude: { options: [{ id: "opus", label: "Opus 4.6" }], defaultId: "opus" } };

function row(key: string, title: string): TicketRow {
  return { key, id: key, title, statusCategory: "doing", statusLabel: "In Progress", priority: "High", project: key.split("-")[0], updatedAt: Date.now() - 60_000, url: `https://acme.atlassian.net/browse/${key}` };
}
const NGL9 = row("NGL-9", "Stop the spinner on the phone");
const NGL4 = row("NGL-4", "Profile page copy");

function ticketQuery(ticket: TicketRow): QueryState {
  return { query: "ticket", param: ticket.key, detail: { ...ticket, descriptionMd: "It spins forever.", comments: [] }, status: "ok", reading: false, observedAt: Date.now() - 60_000, source: "open" };
}

function jira(): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0 }],
    fetchRuntime: "claude",
    site: { id: SITE, url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project: null },
    queries: [{ query: "mine", param: null, items: [NGL9, NGL4], status: "ok", reading: false, observedAt: Date.now() - 60_000, source: "open" }, ticketQuery(NGL9), ticketQuery(NGL4)],
  };
}

function agent(over: Partial<RoomAgent>): RoomAgent {
  return { agentId: "room-1", role: "principal", title: "Profile page", runtime: "claude", model: "opus", createdBy: "user", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}
const principal = agent({});
const worker = agent({ agentId: "worker-1", role: "worker", parentId: "room-1", title: "Stop the spinner", ticket: { provider: "jira", key: "NGL-9", title: NGL9.title } });

function summary(tickets?: RoomTicketView[]): RoomSummary {
  return { counts: { working: 2, awaiting_user: 0, queued: 0, waiting: 0, done: 0, blocked: 0, failed: 0, stopped: 0 }, needsYou: 0, live: 2, liveLimit: 10, ...(tickets ? { tickets } : {}) };
}

function workerLink(): WorkTicket {
  return {
    sessionId: "worker-1",
    ticket: { provider: "jira", site: SITE, key: "NGL-9" },
    origin: "delegate",
    linkedAt: Date.now(),
    title: NGL9.title,
    lineDue: false,
    place: { roomId: "room-1", roomTitle: "Profile page", agentTitle: "Stop the spinner", agentState: "working" },
  };
}

let relay: FakeRelay;
let requests: { path: string; method: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
});

afterEach(async () => {
  cleanup();
  // Unmounting a room writes its layout back; let that request leave while
  // `fetch` is still the fake one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  relay.uninstall();
});

/** The fake relay, with Jira on the profile and a room's HTTP surface. */
function start(links: WorkTicket[] = []): void {
  relay = installFakeRelay("on it", { agentId: "claude", catalogs, integrations: { [RELAY]: { integrations: [jira()], links } } });
  requests = [];
  const relayFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path.startsWith("/rooms")) requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path === "/rooms" && method === "POST") return json({ roomId: "room-2" }, 201);
      if (/^\/rooms\/room-\d\/canvas$/.test(path)) return json({ canvas: { positions: {}, areas: [], texts: [] } });
      if (/^\/rooms\/room-\d\/context$/.test(path)) return json({ dir: "/x", items: [], index: "" });
      if (/^\/rooms\/room-\d\/worktrees$/.test(path)) return json({ worktrees: [], totalSizeBytes: 0 });
      if (/^\/rooms\/room-\d$/.test(path)) return json({ members: [] });
      if (path === "/sessions/delete") return json({ ok: true });
      return relayFetch(url, init);
    }),
  );
}

const sentOfType = (type: string) => relay.sent.filter((entry) => entry.message.type === type);
/** Every tab stays mounted; the ones in the background are `invisible`. */
const onScreen = <T extends Element>(elements: T[]): T[] => elements.filter((element) => !element.closest(".invisible"));
const pane = (kind: string) => document.querySelector<HTMLElement>(`[data-dock-pane="${kind}"]`);

async function seedSessions(sessions: SessionSummary[]): Promise<void> {
  await waitFor(() => expect(relay.sockets.some((socket) => socket.url.includes("/sessions/watch") && socket.readyState === 1)).toBe(true), SLOW);
  act(() => relay.emit({ type: "session_list_snapshot", sessions }));
}

async function newConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await waitFor(() => expect(onScreen(screen.queryAllByLabelText(en.chat.composer.placeholder))).toHaveLength(1), SLOW);
}

async function openTicket(user: ReturnType<typeof userEvent.setup>, title: RegExp): Promise<void> {
  const rail = onScreen(await screen.findAllByTestId("dock-rail", undefined, SLOW))[0];
  if (!pane("integration")) await user.click(await within(rail).findByRole("button", { name: "Jira" }));
  await user.click(await within(pane("integration")!).findByRole("button", { name: title }));
  await screen.findByTestId("ticket-screen");
}

/** Waits for the room's channel and says what is in it. */
async function roomSays(roomId: string, agents: RoomAgent[], roomSummary: RoomSummary): Promise<void> {
  await waitFor(() => expect(relay.sockets.some((s) => s.url.includes(`/rooms/${roomId}/watch`))).toBe(true), SLOW);
  act(() => relay.emit({ type: "room_snapshot", roomId, agents, summary: roomSummary }));
  await screen.findByTestId("sala-canvas", undefined, SLOW);
}

async function chooseRoom(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(within(screen.getByTestId("ticket-work-actions")).getByRole("button", { name: work.workInRoom }));
  const menu = await screen.findByRole("menu");
  await user.click(within(menu).getByRole("menuitem", { name }));
}

describe("tickets in rooms", () => {
  it("hands a ticket to an existing room's principal: a chip in its composer, sent once as startTicket", async () => {
    start();
    const user = userEvent.setup();
    renderApp();
    await seedSessions([
      { id: "room-1", title: "Profile page", lastActiveAt: Date.now() - 1_000, room: true },
      { id: "chat-1", title: "plain chat", lastActiveAt: Date.now() - 2_000 },
    ]);
    await newConversation(user);
    await openTicket(user, /Stop the spinner on the phone/);

    // The profile's rooms, and a new one.
    await user.click(within(screen.getByTestId("ticket-work-actions")).getByRole("button", { name: work.workInRoom }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Profile page", work.newRoom]);
    await user.click(within(menu).getByRole("menuitem", { name: "Profile page" }));

    // The room's tab, with the principal's conversation open beside it and
    // the ticket in its composer. Nothing is sent yet.
    await roomSays("room-1", [principal], summary());
    await waitFor(() => expect(pane("agent")).not.toBeNull(), SLOW);
    const agentPane = pane("agent")!;
    expect(agentPane.querySelector("aside")?.getAttribute("data-panel")).toBe("principal");
    const chip = await within(agentPane).findByTestId("work-ticket-chip", undefined, SLOW);
    expect(chip).toHaveAttribute("data-ticket", "NGL-9");
    expect(sentOfType("user_message")).toHaveLength(0);

    const composer = await within(agentPane).findByLabelText(en.chat.composer.placeholder, undefined, SLOW);
    await user.type(composer, "split this up");
    const send = within(agentPane).getByRole("button", { name: en.common.send });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    const [sent] = sentOfType("user_message");
    expect(sent.url).toContain("session=room-1");
    expect(sent.message).toEqual({ type: "user_message", text: "split this up", startTicket: { provider: "jira", site: SITE, key: "NGL-9" } });
    // The principal never works on a ticket: the chip goes with the message.
    await waitFor(() => expect(within(agentPane).queryByTestId("work-ticket-chip")).toBeNull());
    await user.type(composer, "and another");
    await user.click(send);
    await waitFor(() => expect(sentOfType("user_message")).toHaveLength(2));
    expect(sentOfType("user_message")[1].message).toEqual({ type: "user_message", text: "and another" });
  }, LONG);

  it("opens a new room on the ticket: the room's first message carries its key", async () => {
    start();
    const user = userEvent.setup();
    renderApp();
    await newConversation(user);
    await openTicket(user, /Stop the spinner on the phone/);
    await chooseRoom(user, work.newRoom);

    // The new-session screen, on Room, with the ticket beside the folder.
    await waitFor(() => expect(onScreen(screen.queryAllByRole("radiogroup", { name: en.sala.newSession.modeLabel }))).toHaveLength(1), SLOW);
    const [group] = onScreen(screen.getAllByRole("radiogroup", { name: en.sala.newSession.modeLabel }));
    expect(within(group).getByRole("radio", { name: en.sala.newSession.room })).toBeChecked();
    await waitFor(() => expect(onScreen(screen.queryAllByTestId("work-ticket-chip"))[0]).toHaveAttribute("data-ticket", "NGL-9"));

    const [composer] = onScreen(screen.getAllByLabelText(en.chat.composer.placeholder));
    await user.type(composer, "Fix the spinner");
    const [send] = onScreen(screen.getAllByRole("button", { name: en.common.send }));
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    await waitFor(() => expect(requests.find((r) => r.path === "/rooms" && r.method === "POST")).toBeDefined());
    const created = requests.find((r) => r.path === "/rooms")!.body as Record<string, unknown>;
    expect(created.firstMessage).toBe("Fix the spinner");
    expect(created.ticket).toBe("NGL-9");
    expect(sentOfType("user_message")).toHaveLength(0);

    // The room's principal does not carry it a second time.
    await roomSays("room-2", [agent({ agentId: "room-2" })], summary([{ provider: "jira", key: "NGL-9", agentIds: [], carried: true }]));
    await user.click(screen.getByRole("button", { name: /Orchestrator, Running/ }));
    await waitFor(() => expect(pane("agent")).not.toBeNull(), SLOW);
    await within(pane("agent")!).findByLabelText(en.chat.composer.placeholder, undefined, SLOW);
    expect(within(pane("agent")!).queryByTestId("work-ticket-chip")).toBeNull();
  }, LONG);

  it("shows a worker's ticket on its card, its panel and the room's About, and lets go of it", async () => {
    start([workerLink()]);
    const user = userEvent.setup();
    renderApp();
    await seedSessions([{ id: "room-1", title: "Profile page", lastActiveAt: Date.now() - 1_000, room: true }]);
    await user.click(await screen.findByRole("button", { name: /Profile page/ }, SLOW));
    await roomSays("room-1", [principal, worker], summary([
      { provider: "jira", key: "NGL-9", title: NGL9.title, agentIds: ["worker-1"] },
      { provider: "jira", key: "NGL-4", agentIds: [], carried: true },
    ]));

    // The worker's card shows its ticket, where it stands from the cache; the principal's shows none.
    const card = (id: string) => document.querySelector<HTMLElement>(`.sala-node[data-agent-id="${id}"]`)!;
    const cardChip = await within(card("worker-1")).findByTestId("room-ticket-chip");
    expect(cardChip).toHaveTextContent("NGL-9");
    expect(cardChip.querySelector("[data-status-category]")).toHaveAttribute("data-status-category", "doing");
    expect(within(card("room-1")).queryByTestId("room-ticket-chip")).toBeNull();

    // A click on it opens the ticket's screen.
    await user.click(cardChip);
    expect(await within(pane("integration")!).findByTestId("ticket-screen")).toHaveTextContent(NGL9.title);

    // About: the ticket with its agent, and the one only the principal holds.
    await user.click(await screen.findByRole("button", { name: en.panels.openRoomAbout }));
    await waitFor(() => expect(pane("about")).not.toBeNull());
    const about = pane("about")!;
    expect(within(about).getByText(en.sala.panel.aboutRoom.tickets)).toBeInTheDocument();
    const rows = [...about.querySelectorAll<HTMLElement>("[data-room-ticket]")];
    expect(rows.map((r) => r.getAttribute("data-room-ticket"))).toEqual(["NGL-9", "NGL-4"]);
    expect(rows[0]).toHaveTextContent("Stop the spinner");
    expect(rows[1]).toHaveTextContent(en.sala.panel.aboutRoom.withPrincipal);
    // Its title comes from the cache when the relay sends none.
    expect(rows[1]).toHaveTextContent(NGL4.title);

    // The worker's panel: the chip beside who delegated it, and ✕ lets go.
    await user.click(within(card("worker-1")).getByRole("button", { name: /Stop the spinner, Running/ }));
    await user.click(await screen.findByRole("button", { name: en.sala.card.actions.open }));
    await waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="agent"]')).not.toBeNull(), SLOW);
    const panelChip = await within(pane("agent")!).findByTestId("work-ticket-chip");
    expect(panelChip).toHaveAttribute("data-ticket", "NGL-9");
    await user.click(within(panelChip).getByRole("button", { name: work.unlinkAgent.replace("{key}", "NGL-9") }));
    expect(sentOfType("work_ticket").map((s) => s.message)).toEqual([{ type: "work_ticket", sessionId: "worker-1", action: "unlink" }]);
  }, LONG);

  it("lists a room's agent on the ticket's screen with its state, and a click brings it forward in its room", async () => {
    start([workerLink()]);
    const user = userEvent.setup();
    renderApp();
    await seedSessions([{ id: "room-1", title: "Profile page", lastActiveAt: Date.now() - 1_000, room: true }]);
    await newConversation(user);
    await openTicket(user, /Stop the spinner on the phone/);

    // The list row names a room's agent by its own title (workers are not in the session list).
    await user.click(within(pane("integration")!).getByRole("button", { name: /All mine/ }));
    const listRow = await within(pane("integration")!).findByRole("button", { name: /Stop the spinner on the phone/ });
    expect(within(listRow).getByTestId("session-link-chips")).toHaveTextContent("Stop the spinner");
    await user.click(listRow);

    const sessions = await screen.findByTestId("ticket-sessions");
    const agentRow = within(sessions).getByRole("button", { name: /Profile page › Stop the spinner/ });
    expect(agentRow).toHaveTextContent(work.agentStates.working);
    expect(agentRow.querySelector("[data-activity]")).toHaveAttribute("data-activity", "running");

    await user.click(agentRow);
    await roomSays("room-1", [principal, worker], summary([{ provider: "jira", key: "NGL-9", agentIds: ["worker-1"] }]));
    // The agent's conversation opens and its card is selected.
    await waitFor(() => expect(pane("agent")?.querySelector('aside[data-panel="agent"]')).not.toBeNull(), SLOW);
    expect(within(pane("agent")!).getByText("Stop the spinner")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.sala-node[data-agent-id="worker-1"]')).toHaveClass("sel"));
  }, LONG);
});
