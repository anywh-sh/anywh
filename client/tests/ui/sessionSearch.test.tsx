import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles, type Profile } from "@/lib/profiles/profiles";
import { setCachedSessions } from "@/lib/format/sessionListCache";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * The ⌘K palette inside the real `App`. It searches the cached session list,
 * so the one thing worth pinning beyond its behaviour is that using it never
 * goes to a relay — a profile with a suspended sandbox would be woken by it.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

let relay: FakeRelay;
let fetchMock: ReturnType<typeof vi.fn>;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function fakeJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

let suffix = 0;
function freshProfiles(): [Profile, Profile] {
  suffix += 1;
  return [
    { id: `a-${String(suffix)}`, label: "Profile A", host: "1.2.3.4", relayPort: 8001 },
    { id: `b-${String(suffix)}`, label: "Profile B", host: "5.6.7.8", relayPort: 8002 },
  ];
}

beforeEach(() => {
  localStorage.clear();
  relay = installFakeRelay();
  fetchMock = vi.fn((input: string) => {
    const url = input;
    if (url.includes("1.2.3.4:8001/sessions")) {
      return Promise.resolve(fakeJsonResponse({ sessions: [{ id: "s-a", title: "Fix the relay for ios", lastActiveAt: now - 60_000 }] }));
    }
    return Promise.resolve(fakeJsonResponse({}, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

/** Profile B is never reachable in these tests: its rows come from the cache
 * alone, written a day ago, which is the whole point of the palette. */
async function renderWithCachedB(): Promise<{ user: ReturnType<typeof userEvent.setup>; b: Profile }> {
  const [a, b] = freshProfiles();
  setProfiles([a, b]);
  setCachedSessions(b.id, [
    { id: "s-b1", title: "Migração do banco", lastActiveAt: now - 2 * DAY },
    { id: "s-b2", title: "Relay notes for the ios build", lastActiveAt: now - 3 * DAY },
  ]);
  renderApp();
  await screen.findByText("Fix the relay for ios");
  return { user: userEvent.setup(), b };
}

async function openSearch(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.keyboard("{Control>}k{/Control}");
  return await screen.findByRole("combobox", { name: en.shell.search.placeholder });
}

function optionTitles(): string[] {
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

describe("session search", () => {
  it("opens with ⌘K, filters by words in any order and ignoring accents, and groups by profile", async () => {
    const { user } = await renderWithCachedB();
    const input = await openSearch(user);

    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText(en.shell.search.totalMany.replace("{count}", "3"))).toBeInTheDocument();

    await user.type(input, "ios relay");
    expect(optionTitles()).toHaveLength(2);
    const listbox = screen.getByRole("listbox");
    expect(listbox.textContent).toContain("Profile A");
    expect(listbox.textContent).toContain("Profile B");

    await user.clear(input);
    await user.type(input, "MIGRACAO");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Migração do banco");
    expect(screen.getByText(en.shell.search.resultsOne)).toBeInTheDocument();
  });

  it("moves with the arrow keys, wrapping, and opens the highlighted session of its own profile", async () => {
    const { user } = await renderWithCachedB();
    const input = await openSearch(user);
    const before = relay.sockets.length;

    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[options.length - 1].id);
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    await user.type(input, "banco{Enter}");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // The session belongs to profile B, so the tab it opens talks to B's relay.
    await vi.waitFor(() => expect(relay.sockets.slice(before).some((socket) => socket.url.includes("5.6.7.8:8002"))).toBe(true));
  });

  it("clears the query on the first Esc and closes on the second", async () => {
    const { user } = await renderWithCachedB();
    const input = await openSearch(user);
    await user.type(input, "banco");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    await vi.waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
  });

  it("says so when nothing matches", async () => {
    const { user } = await renderWithCachedB();
    const input = await openSearch(user);
    await user.type(input, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(en.shell.search.emptyTitle.replace("{query}", "zzz"))).toBeInTheDocument();
    expect(screen.getByText(en.shell.search.emptyHint)).toBeInTheDocument();
  });

  it("shows how old each inactive profile's rows are, and nothing for the connected one", async () => {
    const { user } = await renderWithCachedB();
    await openSearch(user);
    const listbox = screen.getByRole("listbox");
    // The header text is aria-hidden, so read it from the DOM, not by role.
    const text = listbox.textContent ?? "";
    expect(text).toContain("Profile B");
    expect(text).toMatch(/synced/);
    expect(within(listbox).getAllByText(/synced/)).toHaveLength(1);
  });

  it("reaches no relay while it is opened and typed into", async () => {
    const { user } = await renderWithCachedB();
    const fetchesBefore = fetchMock.mock.calls.length;
    const socketsBefore = relay.sockets.length;
    const sentBefore = relay.sent.length;

    const input = await openSearch(user);
    await user.type(input, "relay");
    await user.clear(input);
    await user.type(input, "banco");

    expect(fetchMock.mock.calls.length).toBe(fetchesBefore);
    expect(relay.sockets.length).toBe(socketsBefore);
    expect(relay.sent.length).toBe(sentBefore);
  });
});
