import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { IntegrationState, QueryState, TicketDetail, TicketRow, WorkTicket } from "@/lib/integrations/model";
import type { SessionSummary } from "@/lib/relay/relay-types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };
const work = en.integrations.work;
const SITE = "cloud-1";

function row(key: string, title: string): TicketRow {
  return {
    key,
    id: key,
    title,
    statusCategory: "todo",
    statusLabel: "To Do",
    priority: "Medium",
    project: key.split("-")[0],
    updatedAt: Date.now() - 60_000,
    url: `https://acme.atlassian.net/browse/${key}`,
  };
}

const NGL1144 = row("NGL-1144", "Paginate the orders list");
const NGL7 = row("NGL-7", "Export orders as CSV");

function detail(ticket: TicketRow): TicketDetail {
  return { ...ticket, descriptionMd: "Swap infinite scroll for pages.", comments: [] };
}

function ticketQuery(ticket: TicketRow): QueryState {
  return { query: "ticket", param: ticket.key, detail: detail(ticket), status: "ok", reading: false, observedAt: Date.now() - 60_000, source: "open" };
}

function jira(): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0 }],
    fetchRuntime: "claude",
    site: { id: SITE, url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project: null },
    queries: [
      { query: "mine", param: null, items: [NGL1144, NGL7], status: "ok", reading: false, observedAt: Date.now() - 60_000, source: "open" },
      ticketQuery(NGL1144),
      ticketQuery(NGL7),
    ],
  };
}

function link(sessionId: string, ticket: TicketRow, linkedAt: number, origin: WorkTicket["origin"] = "manual"): WorkTicket {
  return { sessionId, ticket: { provider: "jira", site: SITE, key: ticket.key }, origin, linkedAt, title: ticket.title, lineDue: false };
}

let relay: FakeRelay;
/** Fresh session ids per test: the session list cache is a module singleton
 * that `localStorage.clear()` does not reach. */
let run = 0;
const id = (name: string) => `${name}-${String(run)}`;
const sentOfType = (type: string) => relay.sent.filter((entry) => entry.message.type === type);

beforeEach(() => {
  run += 1;
  localStorage.clear();
  seedShellProfile();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

function start(links: WorkTicket[]): void {
  relay = installFakeRelay("fake reply", { integrations: { [RELAY]: { integrations: [jira()], links } } });
}

/** The profile's session list, as the relay's `/sessions/watch` sends it. */
async function seedSessions(sessions: SessionSummary[]): Promise<void> {
  await waitFor(() => expect(relay.sockets.some((socket) => socket.url.includes("/sessions/watch") && socket.readyState === 1)).toBe(true), SLOW);
  act(() => relay.emit({ type: "session_list_snapshot", sessions }));
}

async function openJira(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const rail = await screen.findByTestId("dock-rail", undefined, SLOW);
  await user.click(await within(rail).findByRole("button", { name: "Jira" }));
  await screen.findByTestId("integration-panel-header");
}

async function startNewConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await waitFor(() => expect(onScreen(screen.queryAllByLabelText(en.chat.composer.placeholder))).toHaveLength(1), SLOW);
}

/** Opens an existing session from the sidebar, which makes it the session
 * beside the pane. */
async function openSession(user: ReturnType<typeof userEvent.setup>, title: RegExp): Promise<void> {
  await user.click(await screen.findByRole("button", { name: title }, SLOW));
  await waitFor(() => expect(onScreen(screen.queryAllByLabelText(en.chat.composer.placeholder))).toHaveLength(1), SLOW);
}

const LONG = 20_000;
/** Every tab stays mounted; the ones in the background are `invisible`. */
function onScreen<T extends Element>(elements: T[]): T[] {
  return elements.filter((element) => !element.closest(".invisible"));
}
const chip = (): HTMLElement | null => onScreen(screen.queryAllByTestId("work-ticket-chip"))[0] ?? null;

async function send(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const [composer] = onScreen(screen.getAllByLabelText(en.chat.composer.placeholder));
  await user.type(composer, text);
  const [button] = onScreen(screen.getAllByRole("button", { name: en.common.send }));
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

describe("working on a ticket", () => {
  it("lists every session on a ticket with its activity, and a click opens the chosen one", async () => {
    const [running, idle, third] = [id("running"), id("idle"), id("third")];
    start([link(running, NGL1144, 3), link(idle, NGL1144, 2), link(third, NGL1144, 1)]);
    const user = userEvent.setup();
    renderApp();
    await seedSessions([
      { id: running, title: "export csv", lastActiveAt: Date.now() - 1_000, activity: "running", workTicket: { provider: "jira", key: "NGL-1144" } },
      { id: idle, title: "fix filter", lastActiveAt: Date.now() - 2_000, workTicket: { provider: "jira", key: "NGL-1144" } },
      { id: third, title: "orders page", lastActiveAt: Date.now() - 3_000, workTicket: { provider: "jira", key: "NGL-1144" } },
    ]);

    // The sidebar carries the key of the ticket each session works on.
    const sidebarRow = await screen.findByRole("button", { name: /fix filter/ });
    expect(within(sidebarRow).getByTestId("session-work-ticket")).toHaveTextContent("NGL-1144");

    await startNewConversation(user);
    await openJira(user);

    // The list row names two sessions, the running one with its spinner, and
    // how many more.
    const listRow = await screen.findByRole("button", { name: /Paginate the orders list/ });
    const chips = within(listRow).getByTestId("session-link-chips");
    expect(within(chips).getByText("export csv").parentElement?.querySelector("[data-activity]")).toHaveAttribute("data-activity", "running");
    expect(within(chips).getByText("fix filter")).toBeInTheDocument();
    expect(within(chips).getByText("+1")).toBeInTheDocument();

    await user.click(listRow);
    const sessions = await screen.findByTestId("ticket-sessions");
    expect(within(sessions).getAllByRole("button").map((button) => button.getAttribute("data-session-link"))).toEqual([running, idle, third]);
    // The new-session tab beside the pane has no session yet: only "New session".
    expect(screen.queryByRole("button", { name: work.workHere })).toBeNull();
    expect(within(screen.getByTestId("ticket-work-actions")).getByRole("button", { name: work.newSession })).toBeInTheDocument();

    await user.click(within(sessions).getByRole("button", { name: /fix filter/ }));
    await waitFor(() => expect(relay.sockets.some((socket) => socket.url.includes(`session=${idle}`))).toBe(true), SLOW);
  }, LONG);

  it("starts a new session on the ticket, with the key told to the relay and only the typed text shown", async () => {
    start([]);
    const user = userEvent.setup();
    renderApp();
    await startNewConversation(user);
    await openJira(user);
    await user.click(await screen.findByRole("button", { name: /Paginate the orders list/ }));
    await user.click(within(await screen.findByTestId("ticket-work-actions")).getByRole("button", { name: work.newSession }));

    // Straight to the new-session screen, with the chip beside the folder.
    await waitFor(() => expect(chip()).toHaveAttribute("data-ticket", "NGL-1144"));
    expect(chip()?.parentElement?.textContent).toContain("NGL-1144");

    await send(user, "  take the *first* page");
    const [first] = sentOfType("user_message");
    expect(first.message).toEqual({ type: "user_message", text: "  take the *first* page", startTicket: { provider: "jira", site: SITE, key: "NGL-1144" } });
    expect(await screen.findByText(/take the/)).toBeInTheDocument();
    expect(screen.queryByText(/Jira ticket:/)).toBeNull();

    // The relay links the session; the chip stays where it was, now the
    // session's work ticket, and opens the ticket's screen.
    const sessionId = new URL(first.url).searchParams.get("session")!;
    act(() => relay.emitOnIntegrations(RELAY, { type: "work_ticket_upsert", link: link(sessionId, NGL1144, Date.now(), "start") }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-ticket", "NGL-1144"));
    await user.click(within(chip()!).getByRole("button", { name: work.openTicket.replace("{key}", "NGL-1144") }));
    expect(await screen.findByTestId("ticket-screen")).toHaveTextContent("Paginate the orders list");

    // A later message carries no ticket.
    await send(user, "next");
    expect(sentOfType("user_message")[1].message).toEqual({ type: "user_message", text: "next" });
  }, LONG);

  it("drops the ticket from a new session with its ✕", async () => {
    start([]);
    const user = userEvent.setup();
    renderApp();
    await startNewConversation(user);
    await openJira(user);
    await user.click(await screen.findByRole("button", { name: /Paginate the orders list/ }));
    await user.click(within(await screen.findByTestId("ticket-work-actions")).getByRole("button", { name: work.newSession }));
    await waitFor(() => expect(chip()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: work.dropPending.replace("{key}", "NGL-1144") }));
    expect(chip()).toBeNull();
    await send(user, "plain session");
    expect(sentOfType("user_message")[0].message).toEqual({ type: "user_message", text: "plain session" });
  }, LONG);

  it("works on a ticket in the current session, and lets go of it with the chip's ✕", async () => {
    const [free, busy] = [id("free"), id("busy")];
    start([link(busy, NGL7, 1)]);
    const user = userEvent.setup();
    renderApp();
    await seedSessions([
      { id: free, title: "free session", lastActiveAt: Date.now() - 1_000 },
      { id: busy, title: "busy session", lastActiveAt: Date.now() - 2_000, workTicket: { provider: "jira", key: "NGL-7" } },
    ]);

    // A session that already works on a ticket: another ticket only offers a
    // new session.
    await openSession(user, /^busy session/);
    await openJira(user);
    await waitFor(() => expect(chip()).toHaveAttribute("data-ticket", "NGL-7"));
    await user.click(await screen.findByRole("button", { name: /Paginate the orders list/ }));
    await screen.findByTestId("ticket-screen");
    expect(screen.queryByRole("button", { name: work.workHere })).toBeNull();
    expect(within(screen.getByTestId("ticket-work-actions")).getByRole("button", { name: work.newSession })).toBeInTheDocument();

    // A free one can take it.
    await openSession(user, /^free session/);
    await openJira(user);
    await user.click(await screen.findByRole("button", { name: /Paginate the orders list/ }));
    await user.click(await screen.findByRole("button", { name: work.workHere }));
    expect(sentOfType("work_ticket").map((entry) => entry.message)).toEqual([
      { type: "work_ticket", sessionId: free, action: "link", ticket: { provider: "jira", site: SITE, key: "NGL-1144" } },
    ]);
    act(() => relay.emitOnIntegrations(RELAY, { type: "work_ticket_upsert", link: link(free, NGL1144, Date.now()) }));
    await waitFor(() => expect(chip()).toHaveAttribute("data-ticket", "NGL-1144"));
    await waitFor(() => expect(screen.queryByRole("button", { name: work.workHere })).toBeNull());
    expect(within(screen.getByTestId("ticket-sessions")).getByRole("button", { name: /free session/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: work.unlink.replace("{key}", "NGL-1144") }));
    expect(sentOfType("work_ticket")[sentOfType("work_ticket").length - 1].message).toEqual({ type: "work_ticket", sessionId: free, action: "unlink" });
    act(() => relay.emitOnIntegrations(RELAY, { type: "work_ticket_removed", sessionId: free }));
    await waitFor(() => expect(chip()).toBeNull());
    expect(await screen.findByRole("button", { name: work.workHere })).toBeInTheDocument();
  }, LONG);
});
