import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay, type FakeIntegrations } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import type { IntegrationState, TicketRow, WorkTicket } from "@/lib/integrations/model";
import type { SessionSummary } from "@/lib/relay/relay-types";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };
const LONG = 20_000;
const SITE = "cloud-1";
const tickets = en.chat.composer.tickets;

function row(key: string, title: string, statusCategory: TicketRow["statusCategory"] = "todo"): TicketRow {
  return { key, id: key, title, statusCategory, statusLabel: statusCategory === "doing" ? "In Progress" : "To Do", priority: "Medium", project: key.split("-")[0], updatedAt: Date.now(), url: `https://acme.atlassian.net/browse/${key}` };
}
const NGL12 = row("NGL-12", "Filter by date", "doing");
const NGL30 = row("NGL-30", "Orders pagination");
const NGL7 = row("NGL-7", "Export orders as CSV");

function jira(): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0 }],
    fetchRuntime: "claude",
    site: { id: SITE, url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project: null },
    queries: [{ query: "mine", param: null, items: [NGL12, NGL30, NGL7], status: "ok", reading: false, observedAt: Date.now(), source: "open" }],
  };
}

let relay: FakeRelay;
let run = 0;
const id = (name: string) => `${name}-${String(run)}`;
const sentOfType = (type: string) => relay.sent.filter((entry) => entry.message.type === type);
const onScreen = <T extends Element>(elements: T[]): T[] => elements.filter((element) => !element.closest(".invisible"));

beforeEach(() => {
  run += 1;
  localStorage.clear();
  seedShellProfile();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

function start(integrations: FakeIntegrations): void {
  relay = installFakeRelay("fake reply", { integrations: { [RELAY]: integrations } });
}

async function seedSessions(sessions: SessionSummary[]): Promise<void> {
  await waitFor(() => expect(relay.sockets.some((socket) => socket.url.includes("/sessions/watch") && socket.readyState === 1)).toBe(true), SLOW);
  act(() => relay.emit({ type: "session_list_snapshot", sessions }));
}

/** The composer of the tab on screen, once the integrations socket spoke. */
async function composer(): Promise<HTMLElement> {
  await waitFor(() => expect(relay.sent.some((s) => s.url.includes("/integrations/watch")) || relay.sockets.some((s) => s.url.includes("/integrations/watch") && s.readyState === 1)).toBe(true), SLOW);
  await waitFor(() => expect(onScreen(screen.queryAllByLabelText(en.chat.composer.placeholder))).toHaveLength(1), SLOW);
  return onScreen(screen.getAllByLabelText(en.chat.composer.placeholder))[0];
}

const picker = () => screen.queryByTestId("ticket-picker");
const options = () => within(picker()!).getAllByRole("option").map((option) => option.getAttribute("data-ticket-option"));
const chipsIn = (field: HTMLElement) => [...field.querySelectorAll("[data-ticket-chip]")].map((chip) => chip.getAttribute("data-ticket-chip"));

async function sendWith(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const [button] = onScreen(screen.getAllByRole("button", { name: en.common.send }));
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

describe("# in the composer", () => {
  it("opens the ticket menu after a space, not inside a word, with the session's work ticket first", async () => {
    const session = id("busy");
    const link: WorkTicket = { sessionId: session, ticket: { provider: "jira", site: SITE, key: "NGL-7" }, origin: "manual", linkedAt: 1, title: NGL7.title, lineDue: false };
    start({ integrations: [jira()], links: [link] });
    const user = userEvent.setup();
    renderApp();
    await seedSessions([{ id: session, title: "busy session", lastActiveAt: Date.now(), workTicket: { provider: "jira", key: "NGL-7" } }]);
    await user.click(await screen.findByRole("button", { name: /^busy session/ }, SLOW));
    const field = await composer();
    await waitFor(() => expect(onScreen(screen.queryAllByTestId("work-ticket-chip"))[0]).toHaveAttribute("data-ticket", "NGL-7"), SLOW);

    // Inside a word it is just a character.
    await user.type(field, "in C#");
    expect(picker()).toBeNull();

    // After a space: the work ticket, then the person's tickets.
    await user.keyboard(" #");
    await waitFor(() => expect(picker()).not.toBeNull());
    expect(options()).toEqual(["NGL-7", "NGL-12", "NGL-30"]);
    expect(within(picker()!).getByText(tickets.yours)).toBeInTheDocument();

    // Typing narrows by key or title.
    await user.keyboard("pagin");
    await waitFor(() => expect(options()).toEqual(["NGL-30"]));
  }, LONG);

  it("puts a picked ticket in as one chip, Backspace takes it whole, and the message carries only its key", async () => {
    start({ integrations: [jira()], links: [] });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const field = await composer();

    // At the start of the line too; picked with the mouse.
    await user.type(field, "#");
    await waitFor(() => expect(options()).toEqual(["NGL-12", "NGL-30", "NGL-7"]));
    await user.click(within(picker()!).getByRole("option", { name: /Orders pagination/ }));
    await waitFor(() => expect(chipsIn(field)).toEqual(["NGL-30"]));
    expect(picker()).toBeNull();

    // Backspace removes the chip in one go (the space after it, then it).
    await user.keyboard("{Backspace}{Backspace}");
    await waitFor(() => expect(chipsIn(field)).toEqual([]));
    expect(field.textContent).toBe("");

    // Picked with the keyboard.
    await user.keyboard("look at #filter");
    await waitFor(() => expect(options()).toEqual(["NGL-12"]));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(chipsIn(field)).toEqual(["NGL-12"]));
    await user.keyboard("now");
    await sendWith(user);

    await waitFor(() => expect(sentOfType("user_message")).toHaveLength(1));
    // Exactly what a plain message is: no extra field, no link, no work ticket.
    expect(sentOfType("user_message")[0].message).toEqual({ type: "user_message", text: "look at NGL-12 now" });
    expect(sentOfType("work_ticket")).toEqual([]);
    expect(onScreen(screen.queryAllByTestId("work-ticket-chip"))).toEqual([]);
  }, LONG);

  it("offers Connect Jira on a profile without it, which opens the connect card", async () => {
    start({ integrations: [] });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const field = await composer();

    await user.type(field, "#");
    await waitFor(() => expect(options()).toEqual(["connect"]));
    await user.click(within(picker()!).getByRole("option", { name: tickets.connect.replace("{name}", "Jira") }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(field.textContent).toBe("");
  }, LONG);

  it("sends #123 on Enter on a profile without Jira, without opening the connect card", async () => {
    start({ integrations: [] });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const field = await composer();

    await user.type(field, "fix #");
    await waitFor(() => expect(options()).toEqual(["connect"]));
    await user.keyboard("123{Enter}");
    await waitFor(() => expect(sentOfType("user_message")).toHaveLength(1));
    expect(sentOfType("user_message")[0].message).toEqual({ type: "user_message", text: "fix #123" });
    expect(screen.queryByRole("dialog")).toBeNull();
  }, LONG);

  it("sends a GitHub-style #12 on Enter even when NGL-12 is a ticket; the arrows make Enter pick", async () => {
    start({ integrations: [jira()], links: [] });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    const field = await composer();

    await user.type(field, "see #1");
    await waitFor(() => expect(options()).toEqual(["NGL-12"]));
    await user.keyboard("2{Enter}");
    await waitFor(() => expect(sentOfType("user_message")).toHaveLength(1));
    expect(sentOfType("user_message")[0].message).toEqual({ type: "user_message", text: "see #12" });

    await waitFor(() => expect(field.textContent).toBe(""));
    await user.keyboard("see #12");
    await waitFor(() => expect(options()).toEqual(["NGL-12"]));
    // Nothing drawn as selected while Enter would send, and Tab takes nothing.
    expect(within(picker()!).getByRole("option")).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Tab}");
    expect(chipsIn(field)).toEqual([]);
    expect(field).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(within(picker()!).getByRole("option")).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(chipsIn(field)).toEqual(["NGL-12"]));
    expect(sentOfType("user_message")).toHaveLength(1);
  }, LONG);
});
