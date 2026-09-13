import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ChatPanelModule from "@/components/chat/ChatPanel";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// ChatPanel registers a Tauri drag-drop listener unconditionally on mount
// (getCurrentWebview(), reads window.__TAURI_INTERNALS__ synchronously) —
// same mocks sendMessage.test.tsx uses.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

// Counts renders of the real ChatPanel, transparently — everything else
// about the module (and the component itself) is untouched. ChatPanel sits
// under `TabPanel`'s `memo`, so a count that doesn't move means the render
// either never happened or never reached a conversation — both of which are
// the point of the CSS-custom-property drag technique (useGroupSizeDrag).
let chatPanelRenderCount = 0;
vi.mock("@/components/chat/ChatPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatPanelModule>();
  function CountedChatPanel(props: React.ComponentProps<typeof actual.ChatPanel>) {
    chatPanelRenderCount++;
    return <actual.ChatPanel {...props} />;
  }
  return { ...actual, ChatPanel: CountedChatPanel };
});

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  chatPanelRenderCount = 0;
  relay = installFakeRelay("fake reply");
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

// Every previously-opened tab keeps its own composer mounted (invisible, not
// removed — the flat panel layer), so `findByLabelText` (a single-match
// query) would throw "multiple elements found" for the second tab onward.
// Waits for the count to grow by exactly one instead.
async function openNewConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const before = screen.queryAllByLabelText(en.chat.composer.placeholder).length;
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await vi.waitFor(() => expect(screen.getAllByLabelText(en.chat.composer.placeholder)).toHaveLength(before + 1));
}

function visibleTabPanels(): Element[] {
  return Array.from(document.querySelectorAll('[data-testid^="tab-panel-"]')).filter(
    (el) => !el.classList.contains("invisible"),
  );
}

describe("tab group split — end to end", () => {
  it("splitting a tab keeps both ChatPanels mounted and visible at the same time", async () => {
    const user = userEvent.setup();
    renderApp();

    await openNewConversation(user);
    await openNewConversation(user);
    // Still one group: only the second (active) tab's panel is visible, but
    // both exist in the DOM already (the flat panel layer never unmounts a
    // backgrounded tab).
    expect(document.querySelectorAll('[data-testid^="tab-panel-"]')).toHaveLength(2);
    expect(visibleTabPanels()).toHaveLength(1);

    // Ctrl+\ splits the focused group's active tab into a new group to the
    // right (App.tsx's handleSplitActiveTab) — no dnd-kit gesture needed.
    await user.keyboard("{Control>}\\{/Control}");

    await vi.waitFor(() => expect(visibleTabPanels()).toHaveLength(2));
    expect(await screen.findAllByLabelText(en.chat.composer.placeholder)).toHaveLength(2);
  });

  it("splitting a tab into a new group does not close its WebSocket", async () => {
    const user = userEvent.setup();
    renderApp();

    await openNewConversation(user);
    await openNewConversation(user);
    const activeSocket = relay.sockets[relay.sockets.length - 1];
    const closeSpy = vi.spyOn(activeSocket, "close");

    await user.keyboard("{Control>}\\{/Control}");
    await vi.waitFor(() => expect(visibleTabPanels()).toHaveLength(2));

    // This is the regression the whole flat-panel-layer design (rather than
    // panels nested under per-group JSX) exists to prevent: changing which
    // group owns a tab must never remount its ChatPanel.
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe("tab group resize — performance guards", () => {
  // tests/setup.ts's global clientWidth stub (800px, sized for the
  // virtualizer measurements it exists for) is narrower than MIN_GROUP_PX
  // (900px) — with 3 real groups splitting it, useGroupSizeDrag's own clamp
  // (MIN_GROUP_PX / containerWidth) would compute a fraction over 1 and the
  // drag math would degenerate. Widened locally, only for this block, to a
  // realistic width for 3 groups side by side; restored after.
  let restoreClientWidth: () => void;

  beforeEach(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 3600 });
    restoreClientWidth = () => Object.defineProperty(HTMLElement.prototype, "clientWidth", descriptor);
  });

  afterEach(() => restoreClientWidth());

  function seedThreeGroups(): void {
    localStorage.setItem(
      "anywh:tabs",
      JSON.stringify([
        { id: "s1", profileId: "default", title: "One" },
        { id: "s2", profileId: "default", title: "Two" },
        { id: "s3", profileId: "default", title: "Three" },
      ]),
    );
    localStorage.setItem("anywh:active-tab", "s1");
    localStorage.setItem(
      "anywh:tab-layout",
      JSON.stringify({
        version: 1,
        groups: [
          { id: "g1", tabIds: ["s1"], activeTabId: "s1", size: 1 / 3 },
          { id: "g2", tabIds: ["s2"], activeTabId: "s2", size: 1 / 3 },
          { id: "g3", tabIds: ["s3"], activeTabId: "s3", size: 1 / 3 },
        ],
        focusedGroupId: "g1",
      }),
    );
  }

  async function renderThreeGroupsAndWaitReady(): Promise<void> {
    seedThreeGroups();
    renderApp();
    await vi.waitFor(() => expect(screen.getAllByLabelText(en.chat.composer.placeholder)).toHaveLength(3));
  }

  function startResizeDrag(): void {
    const handle = screen.getByTestId("group-resize-handle-0");
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 });
  }

  function moveResizeDrag(): void {
    for (let step = 1; step <= 10; step++) {
      fireEvent.pointerMove(window, { clientX: 300 + step * 5, pointerId: 1 });
    }
  }

  it("re-renders no ChatPanel while a resize drag is in flight — only once it's released", async () => {
    await renderThreeGroupsAndWaitReady();
    const beforeDrag = chatPanelRenderCount;

    // Pointer down itself sets draggingIndex (a real, one-time React state
    // change — same pattern usePanelDrag/useSplitDrag already use for their
    // own isDragging flag, driving the handle highlight and disabling the
    // CSS transition). That's expected and cheap; it's the *moves* that must
    // cost nothing, which is the part measured below.
    startResizeDrag();
    const afterPointerDown = chatPanelRenderCount;

    moveResizeDrag();
    // Every pointermove above only mutated CSS custom properties directly
    // (useGroupSizeDrag) — no React state changed, so nothing should have
    // re-rendered from the moves themselves.
    expect(chatPanelRenderCount).toBe(afterPointerDown);

    fireEvent.pointerUp(window, { pointerId: 1 });
    // onCommit (setGroupSizes) lands on pointer up and does re-render `App`.
    // It used to drag every mounted conversation along with it; `TabPanel`'s
    // `memo` is what stops that now — a group's width is not something a
    // conversation renders from. Waiting on the persisted layout (rather
    // than on a render that should never come) is what makes the assertion
    // below meaningful: the commit has demonstrably happened by then.
    await vi.waitFor(() => {
      const layout = JSON.parse(localStorage.getItem("anywh:tab-layout") ?? "{}") as {
        groups?: { size: number }[];
      };
      expect(layout.groups?.[0].size).not.toBe(1 / 3);
    });
    expect(chatPanelRenderCount).toBe(afterPointerDown);
    // The counter is live, not trivially stuck at zero: mounting the three
    // conversations above is what moved it in the first place.
    expect(beforeDrag).toBeGreaterThan(0);
  });

  it("writes to localStorage no more than once per resize drag, never per frame", async () => {
    await renderThreeGroupsAndWaitReady();
    // happy-dom's `localStorage` defines `setItem` as an own property (not
    // inherited from `Storage.prototype`) — spying on the prototype method
    // silently never intercepts a real call through the `localStorage`
    // global, so the spy has to sit on the instance itself.
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    setItemSpy.mockClear();

    startResizeDrag();
    moveResizeDrag();
    expect(setItemSpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 1 });
    await vi.waitFor(() => expect(setItemSpy).toHaveBeenCalled());
    // useTabs' persist effect writes three separate keys (anywh:tabs,
    // anywh:active-tab, anywh:tab-layout) per commit — "once per drag" means
    // this one commit's worth, not literally one `setItem` call total.
    expect(setItemSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  /** Every tab stays mounted for as long as it is open, so "how many
   * conversations does this interaction re-render" is a number that scales
   * with how heavily the app is being used. It is supposed to be bounded by
   * what the interaction actually touches — never by how many tabs happen
   * to be open. */
  it("re-renders no conversation when app state unrelated to them changes", async () => {
    await renderThreeGroupsAndWaitReady();
    const user = userEvent.setup({ delay: null });
    const beforeToggle = chatPanelRenderCount;
    expect(beforeToggle).toBeGreaterThan(0);

    // Collapsing the sidebar is the clearest case: it re-renders `App` (the
    // sidebar's width lives there) and touches nothing a conversation
    // renders from.
    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`${en.shell.titleBar.collapseSidebar}|${en.shell.titleBar.expandSidebar}`, "i"),
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: en.shell.sidebar.newConversation })).toBeNull());

    expect(chatPanelRenderCount).toBe(beforeToggle);
  });

  it("re-renders only the two conversations involved in a tab switch", async () => {
    await renderThreeGroupsAndWaitReady();
    const user = userEvent.setup({ delay: null });
    const beforeSwitch = chatPanelRenderCount;

    // Three groups, one tab each: clicking another group's tab moves focus
    // between two of them (`isFocusedTab` flips on each) and leaves the
    // third alone. Two renders, not one per open tab — and, crucially, not a
    // number that would grow with a fourth tab.
    await user.click(screen.getByRole("tab", { name: /Three/ }));
    await vi.waitFor(() => expect(chatPanelRenderCount).toBeGreaterThan(beforeSwitch));

    expect(chatPanelRenderCount - beforeSwitch).toBeLessThanOrEqual(2);
  });
});
