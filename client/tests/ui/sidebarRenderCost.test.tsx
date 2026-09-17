import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as SessionListModule from "@/components/shell/SessionList";
import * as TitleBarModule from "@/components/shell/TitleBar";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { upsertCachedSession } from "@/lib/format/sessionListCache";
import { en } from "@/i18n/en";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

// The probe is the list, not the row: `Sidebar` is memoized, so counting
// there would only say whether the memo bailed, while this says whether the
// whole history was walked — the thing that actually costs milliseconds.
let listRenderCount = 0;
vi.mock("@/components/shell/SessionList", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionListModule>();
  function CountedSessionList(props: React.ComponentProps<typeof actual.SessionList>) {
    listRenderCount++;
    return createElement(actual.SessionList, props);
  }
  return { ...actual, SessionList: CountedSessionList };
});

// Cheap, unmemoized, and mounted for the life of the shell: it re-renders
// exactly when `App` does, which makes it the most direct probe for "how
// many times did the whole app render for this one interaction".
let appRenderCount = 0;
vi.mock("@/components/shell/TitleBar", async (importOriginal) => {
  const actual = await importOriginal<typeof TitleBarModule>();
  function CountedTitleBar(props: React.ComponentProps<typeof actual.TitleBar>) {
    appRenderCount++;
    return createElement(actual.TitleBar, props);
  }
  return { ...actual, TitleBar: CountedTitleBar };
});

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  listRenderCount = 0;
  appRenderCount = 0;
  relay = installFakeRelay("fake reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

function seedTabsAndSessions(): void {
  const ids = ["s1", "s2", "s3"];
  localStorage.setItem("anywh:tabs", JSON.stringify(ids.map((id) => ({ id, profileId: "default", title: id }))));
  localStorage.setItem("anywh:active-tab", "s1");
  localStorage.setItem(
    "anywh:tab-layout",
    JSON.stringify({
      version: 1,
      groups: [{ id: "g1", tabIds: ids, activeTabId: "s1", size: 1 }],
      focusedGroupId: "g1",
    }),
  );
  // Through the real writer: the cache module reads localStorage once, at
  // import time, so seeding its key from here would never reach it.
  for (let index = 0; index < 40; index++) {
    upsertCachedSession("default", `sess-${index}`, `Session ${index}`, Date.now() - index * 1000);
  }
}

async function renderReadyApp(): Promise<ReturnType<typeof userEvent.setup>> {
  seedTabsAndSessions();
  const user = userEvent.setup({ delay: null });
  renderApp();
  await vi.waitFor(() => expect(screen.getAllByLabelText(en.chat.composer.placeholder)).toHaveLength(3));
  // Mount is not one atomic event: each tab's relay connection starts on a
  // `setTimeout(0)` (see useRelayClient), and the profile/theme syncs land
  // on their own microtasks. Measuring before those settle would bill their
  // renders to whatever interaction ran first.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return user;
}

/**
 * The session list holds every session of every profile — hundreds on a real
 * install — and it is mounted for the whole life of the shell. What it costs
 * per interaction is therefore a number that has to stay bounded by what the
 * interaction actually changes.
 */
describe("session list render cost", () => {
  it("walks the list at most once per tab switch", async () => {
    const user = await renderReadyApp();

    listRenderCount = 0;
    await user.click(screen.getByRole("tab", { name: /s2/ }));
    // One is the floor, not waste: the selected row moves, so the list does
    // have something new to draw. It used to render two to three times —
    // once for the switch itself, then again for each state change the
    // switch triggered on its way through `App` (the unread badge being
    // cleared, the navigation history being pushed), neither of which the
    // sidebar draws anything from.
    await vi.waitFor(() => expect(listRenderCount).toBeGreaterThan(0));
    expect(listRenderCount).toBe(1);
  });

  it("costs one app render per tab switch, not one per state change it triggers", async () => {
    const user = await renderReadyApp();

    appRenderCount = 0;
    await user.click(screen.getByRole("tab", { name: /s2/ }));
    await vi.waitFor(() => expect(appRenderCount).toBeGreaterThan(0));

    // A switch sets the active tab — one render. What it must not do is pay
    // again for each thing that reacts to it: clearing the unread badge of a
    // tab that has none, and pushing a navigation entry that leaves both
    // Back and Forward exactly as they were, each used to cost another full
    // render of the app.
    expect(appRenderCount).toBe(1);
  });

  it("does not touch the list for app state it does not draw", async () => {
    const user = await renderReadyApp();

    listRenderCount = 0;
    // Ctrl+Shift+E opens the files pane: real `App` state, and nothing the
    // sidebar renders from.
    await user.keyboard("{Control>}{Shift>}E{/Shift}{/Control}");
    await vi.waitFor(() => expect(screen.getAllByTestId(/tab-panel-/).length).toBeGreaterThan(0));

    expect(listRenderCount).toBe(0);
  });
});
