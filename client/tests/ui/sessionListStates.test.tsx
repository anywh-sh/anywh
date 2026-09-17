import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles, type Profile } from "@/lib/profiles/profiles";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * Drives the real `App` through the unified session list: one list holding
 * every profile's conversations, a multi-select filter over it, and rows
 * that open a tab against their own profile rather than the active one.
 *
 * Same tier/reasoning as connectToken.test.tsx — the fake relay's WS layer
 * plus a custom fetch router are the only mocked edge.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;
let sessionFetches: string[] = [];
/** Pending `GET /sessions` for profile B, held open on purpose. */
let heldB: (() => void)[] = [];
let holdB = false;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function fakeJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/**
 * Fresh profile ids per test. The session cache is a module singleton keyed
 * by profile id, and `localStorage.clear()` doesn't reach the in-memory copy
 * — reusing ids would let one test's rows decide what the next one sees.
 * The hosts stay fixed, since that is what the fetch router matches on.
 */
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
  sessionFetches = [];
  heldB = [];
  holdB = false;
  relay = installFakeRelay();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("1.2.3.4:8001/sessions")) {
        sessionFetches.push("a");
        return fakeJsonResponse({
          sessions: [{ id: "s-a", title: "Conversa da A", lastActiveAt: now - 60_000 }],
        });
      }
      if (url.includes("5.6.7.8:8002/sessions")) {
        sessionFetches.push("b");
        if (holdB) await new Promise<void>((resolve) => heldB.push(resolve));
        return fakeJsonResponse({
          sessions: [{ id: "s-b", title: "Conversa da B", lastActiveAt: now - 2 * DAY }],
        });
      }
      return fakeJsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("unified session list", () => {
  it("lists every profile's conversations together, grouped by recency", async () => {
    setProfiles(freshProfiles());
    renderApp();

    // Neither row belongs to the profile the other came from, and both are
    // on screen without switching profile — which used to be the only way
    // to see the second one at all.
    await screen.findByText("Conversa da A");
    await screen.findByText("Conversa da B");

    // Bucketed by when each was last used, not lumped into one flat list.
    expect(screen.getByText(en.shell.sidebar.groups.today)).toBeInTheDocument();
    expect(screen.getByText(en.shell.sidebar.groups.week)).toBeInTheDocument();
    expect(screen.queryByText(en.shell.sidebar.groups.yesterday)).not.toBeInTheDocument();

    // With more than one profile in view, each row names its own.
    expect(screen.getAllByText("Profile A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Profile B").length).toBeGreaterThan(0);
  });

  it("keeps the other profiles' rows on screen while a profile switch is still loading", async () => {
    setProfiles(freshProfiles());
    holdB = true;
    renderApp();

    await screen.findByText("Conversa da A");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.shell.profiles.activeProfile }));
    await user.click(await within(document.body).findByRole("menuitem", { name: /Profile B/ }));

    // The old behaviour blanked the list on every switch, because the rows
    // lived in the switching hook's own state. They are cached per profile
    // now, so a switch never costs the user the list they were reading.
    expect(screen.getByText("Conversa da A")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: en.shell.sidebar.loadingSessions })).not.toBeInTheDocument();

    for (const release of heldB) release();
    await screen.findByText("Conversa da B");
  });

  it("fetches each profile exactly once, and does not re-fan-out on a profile switch", async () => {
    setProfiles(freshProfiles());
    renderApp();

    await screen.findByText("Conversa da A");
    await screen.findByText("Conversa da B");
    // Exactly one each, never two: the active profile is synced by
    // `useSessionNames` and the rest by the one-shot bootstrap, and the two
    // must not overlap. Resolving a connection to a brokered profile spends
    // a single-use token and can wake a sleeping machine, so a duplicate
    // here is a real cost, not just a wasted request.
    expect(sessionFetches).toEqual(["a", "b"]);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.shell.profiles.activeProfile }));
    await user.click(await within(document.body).findByRole("menuitem", { name: /Profile B/ }));
    await vi.waitFor(() => expect(sessionFetches.filter((id) => id === "b")).toHaveLength(2));

    // The point of the whole design: a switch reaches exactly the one
    // profile being switched to. A switch that fanned out to every profile
    // would wake all of them, every single time.
    expect(sessionFetches.filter((id) => id === "a")).toHaveLength(1);
  });

  it("narrows the list to the chosen profiles and refuses to hide the last one", async () => {
    setProfiles(freshProfiles());
    renderApp();
    await screen.findByText("Conversa da B");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.shell.sidebar.filterByProfile }));
    await user.click(await within(document.body).findByRole("menuitemcheckbox", { name: /Profile B/ }));

    await vi.waitFor(() => {
      expect(screen.queryByText("Conversa da B")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Conversa da A")).toBeInTheDocument();

    // Deselecting the last remaining profile is refused — an empty sidebar
    // whose only way out is buried in this same menu is not a state worth
    // being able to reach.
    await user.click(await within(document.body).findByRole("menuitemcheckbox", { name: /Profile A/ }));
    expect(screen.getByText("Conversa da A")).toBeInTheDocument();
  });

  it("opens a session of a non-active profile against that profile, not the active one", async () => {
    const [, profileB] = freshProfiles();
    setProfiles([{ ...profileB, id: profileB.id.replace("b-", "a-"), label: "Profile A", host: "1.2.3.4", relayPort: 8001 }, profileB]);
    renderApp();
    await screen.findByText("Conversa da B");

    const user = userEvent.setup();
    await user.click(screen.getByText("Conversa da B"));

    // The tab has to connect through B's relay. Opening it against the
    // active profile would silently talk to the wrong machine.
    await vi.waitFor(() => {
      expect(relay.sockets.some((socket) => socket.url.includes("5.6.7.8:8002") && socket.url.includes("s-b"))).toBe(true);
    });

    // And the shell follows it: `openTab` records the profile on the tab but
    // does not move the active one by itself, so a row opened this way would
    // otherwise leave the live session-list socket, the tailnet-sidecar
    // reference and the default profile for a new conversation behind on A.
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent(profileB.label);
    });
  });

  // A self-hosted install updates the client and the relay separately, so
  // talking to a relay that predates `lastActiveAt` on `GET /sessions` is an
  // ordinary state. It used to throw while formatting the row's timestamp,
  // and a throw during render unmounts the whole tree: the entire window
  // went blank, and it stayed blank across restarts because the expanded
  // sidebar is remembered.
  it("renders the list against a relay that sends no lastActiveAt", async () => {
    setProfiles(freshProfiles());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeJsonResponse({ sessions: [{ id: "s-legacy", title: "Conversa sem data" }] })),
    );

    renderApp();

    expect(await screen.findByText("Conversa sem data")).toBeInTheDocument();
    // Kept, under the one heading that claims nothing about when it was
    // used — dropping the row instead would read as lost history.
    expect(screen.getByText(en.shell.sidebar.groups.older)).toBeInTheDocument();
    // Still the real shell around it, not a blank document.
    expect(screen.getByRole("button", { name: en.shell.sidebar.newConversation })).toBeInTheDocument();
  });

  it("shows the skeleton only when there is nothing cached to show", async () => {
    setProfiles(freshProfiles());
    vi.stubGlobal(
      "fetch",
      // Never resolves: a genuinely cold start, nothing cached and no
      // response yet.
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderApp();
    expect(await screen.findByRole("status", { name: en.shell.sidebar.loadingSessions })).toBeInTheDocument();
  });
});
