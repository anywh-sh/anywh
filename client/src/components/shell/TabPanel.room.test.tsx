import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabPanel, type TabPanelActions } from "./TabPanel";
import { setPanelTogglesSlot } from "@/lib/panelTogglesSlot";
import { en } from "@/i18n/en";
import type { DockState } from "@/hooks/tabs/useSessionDock";
import type { Tab } from "@/hooks/tabs/useTabs";

// The canvas is not what this is about: only that a room's tab carries the
// side panel the way a conversation's does.
vi.mock("@/components/sala/RoomPanel", () => ({ RoomPanel: () => <div data-testid="room-canvas" /> }));
vi.mock("@/components/files/FilesPanelSlot", () => ({ FilesPanelSlot: () => <div data-testid="files-pane" /> }));
vi.mock("@/components/terminal/TerminalPanelSlot", () => ({ TerminalPanelSlot: () => <div data-testid="terminal-pane" /> }));

afterEach(() => {
  cleanup();
  setPanelTogglesSlot("g1", null);
});

const room: Tab = { id: "room-1", profileId: "default", title: "A room", room: true, hasUnreadCompletion: false, isRunning: false, hasBackgroundJob: false, isNew: false };
const profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
const closed: DockState = { panes: [], width: 480, splitRatio: 0.5, maximized: null };

function renderRoom(overrides: { dock?: DockState; isVisible?: boolean; isCompact?: boolean; actions?: Partial<TabPanelActions> } = {}) {
  const slot = document.createElement("div");
  slot.setAttribute("data-testid", "strip-slot");
  document.body.appendChild(slot);
  act(() => setPanelTogglesSlot("g1", slot));
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
  return { slot, actions };
}

describe("TabPanel — a room's tab", () => {
  // Regression: a room returned its canvas alone, with no dock and nothing to
  // portal the buttons that open one, so the files and terminal buttons never
  // showed on its tab.
  it("draws the files and terminal buttons into its group's strip", () => {
    const { slot } = renderRoom();
    expect(within(slot).getByRole("button", { name: en.panels.openFiles })).toBeEnabled();
    expect(within(slot).getByRole("button", { name: en.panels.openTerminal })).toBeEnabled();
    expect(screen.getByTestId("room-canvas")).toBeInTheDocument();
  });

  it("toggles the panes of the room's own tab", async () => {
    const { slot, actions } = renderRoom();
    await userEvent.setup().click(within(slot).getByRole("button", { name: en.panels.openFiles }));
    expect(actions.onTogglePane).toHaveBeenCalledWith("room-1", "files");
  });

  it("shows the panes it has open", () => {
    renderRoom({ dock: { ...closed, panes: ["files", "terminal"] } });
    expect(screen.getByTestId("files-pane")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
  });

  it("shows no panes and no buttons while its group's panel is hidden", () => {
    // Hidden: the strip mounts no slot, and the dock it is handed is closed.
    render(
      <TooltipProvider>
        <TabPanel
          tab={room}
          profile={profile}
          groupId="g1"
          dock={closed}
          isVisible
          isCompact={false}
          terminalTabs={{} as never}
          fileTabs={{} as never}
          actions={{ onTogglePane: vi.fn() } as unknown as TabPanelActions}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("button", { name: en.panels.openFiles })).not.toBeInTheDocument();
    expect(screen.queryByTestId("files-pane")).not.toBeInTheDocument();
  });

  it("claims the strip's slot only while it is the group's visible tab", () => {
    const { slot } = renderRoom({ isVisible: false });
    expect(within(slot).queryByRole("button", { name: en.panels.openFiles })).not.toBeInTheDocument();
  });

  it("stays the bare canvas on compact, where there is no side panel", () => {
    const { slot } = renderRoom({ isCompact: true });
    expect(within(slot).queryByRole("button", { name: en.panels.openFiles })).not.toBeInTheDocument();
    expect(screen.getByTestId("room-canvas")).toBeInTheDocument();
  });
});
