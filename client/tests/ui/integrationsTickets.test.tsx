import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { IntegrationState, QueryState, TicketDetail, TicketRow } from "@/lib/integrations/model";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => {
    opened.push(url);
    return Promise.resolve();
  },
}));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };
const copy = en.integrations.tickets;

function row(key: string, title: string, patch: Partial<TicketRow> = {}): TicketRow {
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
    ...patch,
  };
}

const NGL1 = row("NGL-1", "Export orders as CSV", { statusCategory: "doing", statusLabel: "In Progress", priority: "High" });
const ANY7 = row("ANY-7", "Usage view on mobile");
const NGL2 = row("NGL-2", "Paginate the orders list");

function jira(queries: QueryState[], project: string | null = null): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0 }],
    fetchRuntime: "claude",
    site: { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project },
    queries,
  };
}

function mine(param: string | null, items: TicketRow[], patch: Partial<QueryState> = {}): QueryState {
  return { query: "mine", param, items, status: "ok", reading: false, observedAt: Date.now() - 60_000, source: "open", ...patch } as QueryState;
}

let relay: FakeRelay;
const sentOfType = (type: string) => relay.sent.filter((entry) => entry.message.type === type).map((entry) => entry.message);

function start(state: IntegrationState): void {
  relay = installFakeRelay("fake reply", { integrations: { [RELAY]: { integrations: [state] } } });
}

beforeEach(() => {
  localStorage.clear();
  opened.length = 0;
  seedShellProfile();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function openPane(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(en.chat.composer.placeholder, undefined, SLOW);
  const rail = await screen.findByTestId("dock-rail");
  await user.click(await within(rail).findByRole("button", { name: "Jira" }));
  await screen.findByTestId("integration-panel-header");
}

const listedKeys = () => [...screen.getByTestId("ticket-list").querySelectorAll("[data-ticket]")].map((button) => button.getAttribute("data-ticket"));

describe("my tickets in the integration's pane", () => {
  it("opens on All mine from the cache, without Done, and loads more pages", async () => {
    start(jira([]));
    const user = userEvent.setup();
    await openPane(user);

    // Nothing cached: it asks once, without forcing, and says it is loading.
    await waitFor(() => expect(sentOfType("integration_refresh")).toEqual([{ type: "integration_refresh", id: "jira", query: "mine", param: null, force: false }]));
    expect(screen.getByTestId("tickets-loading")).toHaveTextContent(copy.loading);
    expect(screen.getByTestId("project-dropdown")).toHaveTextContent(copy.allMine);

    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1, row("NGL-9", "Shipped", { statusCategory: "done", statusLabel: "Done" }), ANY7], { nextPageToken: "p2" })])]));
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1", "ANY-7"]));
    expect(screen.getByText(copy.countMore.replace("{count}", "2"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.loadMore }));
    expect(sentOfType("integration_load_more")).toEqual([{ type: "integration_load_more", id: "jira", query: "mine", param: null }]);
    expect(screen.getByRole("button", { name: copy.loadMore })).toHaveAttribute("aria-busy", "true");

    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1, ANY7, NGL2])])]));
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1", "ANY-7", "NGL-2"]));
    expect(screen.queryByRole("button", { name: copy.loadMore })).toBeNull();
    expect(screen.getByText(copy.count.replace("{count}", "3"))).toBeInTheDocument();
  });

  it("groups the list under a foldable heading per status, in progress first", async () => {
    const review = row("NGL-3", "Review the export", { statusCategory: "doing", statusLabel: "In Review" });
    start(jira([mine(null, [ANY7, NGL1, review, NGL2])]));
    const user = userEvent.setup();
    await openPane(user);
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1", "NGL-3", "ANY-7", "NGL-2"]));
    const headings = within(screen.getByTestId("ticket-list")).getAllByRole("button", { expanded: true });
    expect(headings.map((heading) => heading.textContent)).toEqual(["In Progress1", "In Review1", "To Do2"]);

    // A folded status keeps its heading and count; its rows go.
    await user.click(headings[2]);
    expect(headings[2]).toHaveAttribute("aria-expanded", "false");
    expect(headings[2]).toHaveTextContent("To Do2");
    expect(listedKeys()).toEqual(["NGL-1", "NGL-3"]);
    await user.click(headings[2]);
    expect(listedKeys()).toEqual(["NGL-1", "NGL-3", "ANY-7", "NGL-2"]);
  });

  it("opens on the remembered project, and a new pick is remembered through the relay", async () => {
    start(jira([mine(null, [NGL1, ANY7]), mine("NGL", [NGL1])], "NGL"));
    const user = userEvent.setup();
    await openPane(user);

    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1"]));
    expect(screen.getByTestId("project-dropdown")).toHaveTextContent("NGL");
    await waitFor(() => expect(sentOfType("integration_refresh")).toContainEqual({ type: "integration_refresh", id: "jira", query: "mine", param: "NGL", force: false }));

    await user.click(screen.getByTestId("project-dropdown"));
    const menu = await screen.findByRole("menu");
    // Every project seen in the cache.
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([expect.stringContaining(copy.allMine), "ANY", "NGL"]);
    await user.click(within(menu).getByRole("menuitem", { name: "ANY" }));

    expect(sentOfType("integration_prefs")).toEqual([{ type: "integration_prefs", id: "jira", prefs: { project: "ANY" } }]);
    await waitFor(() => expect(sentOfType("integration_refresh")).toContainEqual({ type: "integration_refresh", id: "jira", query: "mine", param: "ANY", force: false }));
    expect(screen.getByTestId("project-dropdown")).toHaveTextContent("ANY");

    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1, ANY7]), mine("NGL", [NGL1]), mine("ANY", [ANY7])], "ANY")]));
    await waitFor(() => expect(listedKeys()).toEqual(["ANY-7"]));
  });

  it("opens a ticket's screen and comes back to the list", async () => {
    start(jira([mine(null, [NGL1, NGL2])]));
    const user = userEvent.setup();
    await openPane(user);

    await user.click(await screen.findByRole("button", { name: /Paginate the orders list/ }));
    const ticket = await screen.findByTestId("ticket-screen");
    // The row's title shows while the ticket is read.
    expect(within(ticket).getByRole("heading", { name: "Paginate the orders list" })).toBeInTheDocument();
    expect(within(ticket).getByText(copy.ticket.loading)).toBeInTheDocument();
    await waitFor(() => expect(sentOfType("integration_refresh")).toContainEqual({ type: "integration_refresh", id: "jira", query: "ticket", param: "NGL-2", force: false }));

    const detail: TicketDetail = {
      ...NGL2,
      priority: "Low",
      descriptionMd: "Replace the infinite scroll with **pagination**.",
      comments: [
        { author: "Marina", createdAt: Date.now() - 2 * 86_400_000, bodyMd: "Respect the filter on screen." },
        { author: "Jarrett", createdAt: Date.now() - 86_400_000, bodyMd: "Limit of 10k rows for now." },
      ],
    };
    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1, NGL2]), { query: "ticket", param: "NGL-2", detail, status: "ok", reading: false, observedAt: Date.now() }])]));
    const description = await within(ticket).findByTestId("ticket-description");
    // The chat's own markdown.
    expect(within(description).getByText("pagination").tagName).toBe("STRONG");
    expect(within(ticket).getByText("NGL-2")).toBeInTheDocument();
    expect(within(ticket).getByText(copy.ticket.priority).nextElementSibling).toHaveTextContent("Low");
    expect(within(ticket).getByText("Respect the filter on screen.")).toBeInTheDocument();
    expect(within(ticket).getByText("Limit of 10k rows for now.")).toBeInTheDocument();

    await user.click(within(ticket).getByRole("button", { name: copy.ticket.openIn.replace("{name}", "Jira") }));
    expect(opened).toEqual(["https://acme.atlassian.net/browse/NGL-2"]);

    await user.click(within(ticket).getByRole("button", { name: copy.allMine }));
    await waitFor(() => expect(screen.queryByTestId("ticket-screen")).toBeNull());
    expect(listedKeys()).toEqual(["NGL-1", "NGL-2"]);
  });

  it("refreshes with ↻: it turns while the relay reads, and holds until the relay allows another read", async () => {
    start(jira([mine(null, [NGL1])]));
    const user = userEvent.setup();
    await openPane(user);
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1"]));

    const refresh = screen.getByRole("button", { name: copy.refresh });
    expect(refresh).toHaveAttribute("aria-busy", "false");
    await user.click(refresh);
    expect(sentOfType("integration_refresh")).toContainEqual({ type: "integration_refresh", id: "jira", query: "mine", param: null, force: true });

    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1], { reading: true, readingSince: Date.now(), refreshableAt: Date.now() + 15_000 })])]));
    await waitFor(() => expect(screen.getByRole("button", { name: copy.refresh })).toHaveAttribute("aria-busy", "true"));

    act(() => relay.emitIntegrations(RELAY, [jira([mine(null, [NGL1, NGL2], { observedAt: Date.now(), refreshableAt: Date.now() + 15_000 })])]));
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1", "NGL-2"]));
    const held = screen.getByRole("button", { name: copy.refresh });
    expect(held).toHaveAttribute("aria-busy", "false");
    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(held.getAttribute("title")).toContain(copy.againIn.replace("{duration}", ""));
    const forced = sentOfType("integration_refresh").filter((message) => (message as { force?: boolean }).force).length;
    await user.click(held);
    expect(sentOfType("integration_refresh").filter((message) => (message as { force?: boolean }).force)).toHaveLength(forced);
  });

  it("keeps the last list, dimmed, while the machine is unreachable, and says when a read failed", async () => {
    start(jira([mine(null, [NGL1], { status: "error", error: { kind: "network" } })]));
    const user = userEvent.setup();
    await openPane(user);
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1"]));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.error.replace("{name}", "Jira"));

    // The machine goes away: the socket closes and does not come back yet.
    relay.integrations[RELAY] = "unreachable";
    act(() => {
      for (const socket of relay.sockets) if (new URL(socket.url).pathname === "/integrations/watch") socket.close();
    });
    await waitFor(() => expect(screen.getByTestId("integration-freshness")).toHaveTextContent(copy.offline));
    expect(screen.getByTestId("ticket-list").parentElement).toHaveClass("opacity-60");
    expect(screen.queryByRole("button", { name: copy.refresh })).toBeNull();
    // No project to pick that the relay could not save.
    expect(screen.getByTestId("project-dropdown")).toBeDisabled();
  });

  it("neither switches project nor spins Load more when the ask never left", async () => {
    start(jira([mine(null, [NGL1, ANY7], { nextPageToken: "p2" }), mine("NGL", [NGL1])]));
    const user = userEvent.setup();
    await openPane(user);
    await waitFor(() => expect(listedKeys()).toEqual(["NGL-1", "ANY-7"]));

    // The socket died; its close has not been seen yet, so the pane is live.
    for (const socket of relay.sockets) if (new URL(socket.url).pathname === "/integrations/watch") socket.readyState = 3;

    await user.click(screen.getByRole("button", { name: copy.loadMore }));
    expect(sentOfType("integration_load_more")).toEqual([]);
    expect(screen.getByRole("button", { name: copy.loadMore })).not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: copy.loadMore })).toBeEnabled();

    await user.click(screen.getByTestId("project-dropdown"));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "NGL" }));
    expect(sentOfType("integration_prefs")).toEqual([]);
    expect(screen.getByTestId("project-dropdown")).toHaveTextContent(copy.allMine);
  });
});
