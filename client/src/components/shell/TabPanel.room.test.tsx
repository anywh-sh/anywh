import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabPanel, type TabPanelActions } from "./TabPanel";
import { en } from "@/i18n/en";
import type { DockState } from "@/hooks/tabs/useSessionDock";
import type { Tab } from "@/hooks/tabs/useTabs";

// The canvas is not what this is about: only that a room's tab carries the
// side panel the way a conversation's does. The room draws the dock it is
// handed, so the stand-in does the same.
vi.mock("@/components/sala/RoomPanel", () => ({
  RoomPanel: ({ dock }: { dock: { render: (panes: object) => React.ReactNode } | null }) => (
    <>
      <div data-testid="room-canvas" />
      {dock?.render({})}
    </>
  ),
}));
vi.mock("@/components/files/FilesPanelSlot", () => ({ FilesPanelSlot: () => <div data-testid="files-pane" /> }));
vi.mock("@/components/terminal/TerminalPanelSlot", () => ({ TerminalPanelSlot: () => <div data-testid="terminal-pane" /> }));

afterEach(cleanup);

const room: Tab = { id: "room-1", profileId: "default", title: "A room", room: true, hasUnreadCompletion: false, isRunning: false, hasBackgroundJob: false, isNew: false };
const profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
const closed: DockState = { panes: [], width: 480, maximized: null };

function renderRoom(overrides: { dock?: DockState; isVisible?: boolean; isCompact?: boolean; actions?: Partial<TabPanelActions> } = {}) {
  const actions = { onTogglePane: vi.fn(), ...overrides.actions } as unknown as TabPanelActions;
  render(
    <TooltipProvider>
      <TabPanel
        tab={room}
        profile={profile}
        groupId="g1"
        dock={overrides.dock ?? closed}
        isVisible={overrides.isVisible ?? true}
        isCompact={overrides.isCompact ?? false}
        terminalTabs={{} as never}
        fileTabs={{} as never}
        actions={actions}
      />
    </TooltipProvider>,
  );
  // The tab's own dock draws the rail the buttons are portaled into.
  return { rail: () => screen.getByTestId("dock-rail"), actions };
}

describe("TabPanel — a room's tab", () => {
  // Regression: a room returned its canvas alone, with no dock and nothing to
  // portal the buttons that open one, so the files and terminal buttons never
  // showed on its tab.
  it("draws the files and terminal buttons into its dock's rail", () => {
    const { rail } = renderRoom();
    const slot = rail();
    expect(within(slot).getByRole("button", { name: en.panels.openFiles })).toBeEnabled();
    expect(within(slot).getByRole("button", { name: en.panels.openTerminal })).toBeEnabled();
    expect(screen.getByTestId("room-canvas")).toBeInTheDocument();
  });

  it("toggles the panes of the room's own tab", async () => {
    const { rail, actions } = renderRoom();
    const slot = rail();
    await userEvent.setup().click(within(slot).getByRole("button", { name: en.panels.openFiles }));
    expect(actions.onTogglePane).toHaveBeenCalledWith("room-1", "files");
  });

  it("draws the room's own buttons after files and terminal, and toggles their panes", async () => {
    const { rail, actions } = renderRoom({ dock: { ...closed, panes: ["agent"] } });
    const slot = rail();
    const names = within(slot)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([en.panels.openFiles, en.panels.openTerminal, en.panels.openRoomAbout, en.panels.closeAgent]);
    const user = userEvent.setup();
    await user.click(within(slot).getByRole("button", { name: en.panels.openRoomAbout }));
    await user.click(within(slot).getByRole("button", { name: en.panels.closeAgent }));
    expect(actions.onTogglePane).toHaveBeenCalledWith("room-1", "about");
    expect(actions.onTogglePane).toHaveBeenCalledWith("room-1", "agent");
  });

  it("shows the panes it has open", () => {
    renderRoom({ dock: { ...closed, panes: ["files", "terminal"] } });
    expect(screen.getByTestId("files-pane")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
  });

  // The rail is what is left of the column while the panel is hidden: the
  // panes go, the buttons that open them stay.
  it("keeps the buttons in the rail and shows no panes while the panel is hidden", () => {
    const { rail } = renderRoom();
    expect(within(rail()).getByRole("button", { name: en.panels.openFiles })).toBeEnabled();
    expect(screen.queryByTestId("files-pane")).not.toBeInTheDocument();
  });

  // The left sidebar's selected-row look: raised background and an edge bar.
  it("marks the button of the pane on screen as selected", () => {
    const { rail } = renderRoom({ dock: { ...closed, panes: ["files"] } });
    const files = within(rail()).getByRole("button", { name: en.panels.closeFiles });
    const terminal = within(rail()).getByRole("button", { name: en.panels.openTerminal });
    expect(files).toHaveClass("bg-bg-elevated");
    expect(files.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect(terminal).not.toHaveClass("bg-bg-elevated");
    expect(terminal.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it("claims its group's slot only while it is the group's visible tab", () => {
    renderRoom({ isVisible: false });
    expect(screen.queryByRole("button", { name: en.panels.openFiles })).not.toBeInTheDocument();
  });

  it("stays the bare canvas on compact, where there is no side panel", () => {
    renderRoom({ isCompact: true });
    expect(screen.queryByTestId("dock-rail")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.panels.openFiles })).not.toBeInTheDocument();
    expect(screen.getByTestId("room-canvas")).toBeInTheDocument();
  });
});
