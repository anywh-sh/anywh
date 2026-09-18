import { memo } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { SessionDock } from "@/components/shell/SessionDock";
import { FilesPanelSlot } from "@/components/files/FilesPanelSlot";
import { TerminalPanelSlot } from "@/components/terminal/TerminalPanelSlot";
import type { BackgroundJobSummary } from "@/lib/relay/relayClient";
import type { DockState } from "@/hooks/tabs/useSessionDock";
import type { useFileTabs } from "@/hooks/tabs/useFileTabs";
import type { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import type { Tab } from "@/hooks/tabs/useTabs";
import type { Profile } from "@/lib/profiles/profiles";
import { isIOS } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

/**
 * Everything a tab's panel needs to call back into `App`, as one object
 * built once (`useMemo` there) instead of a closure per tab per render.
 *
 * Every callback takes what it operates on as an argument — the tab, the
 * profile, the path — and closes over nothing that changes. That is the
 * whole point: it lets `TabPanel` below be `memo`'d, and it means none of
 * these can go stale. The two values that made the old inline closures
 * unmemoizable (`windowFocused` and the active tab id, both read at the
 * moment a turn finishes rather than at render time) are read from refs on
 * the `App` side for the same reason.
 */
export interface TabPanelActions {
  onTurnActiveChange: (tabId: string, active: boolean) => void;
  onBackgroundJobsChange: (tabId: string, jobs: BackgroundJobSummary[]) => void;
  onTurnComplete: (
    tab: Tab,
    profile: Profile,
    result: { stopped: boolean; lastUserText: string | null; lastAssistantText: string | null },
  ) => void;
  onTitle: (tab: Tab, title: string) => void;
  onActivity: (tab: Tab) => void;
  onDeleted: (tab: Tab) => void;
  onConnectedChange: (tabId: string, connected: boolean) => void;
  onTogglePane: (tabId: string, kind: "terminal" | "files") => void;
  onClosePane: (tabId: string, kind: "terminal" | "files") => void;
  onToggleMaximized: (tabId: string, kind: "terminal" | "files") => void;
  onOpenPath: (profile: Profile, tabId: string, path: string) => void;
  onOpenTerminalAt: (tabId: string, path: string) => void;
  onDockWidthChange: (tabId: string, width: number) => void;
  onDockSplitRatioChange: (tabId: string, ratio: number) => void;
  onDockDragEnd: () => void;
}

interface TabChatProps {
  tab: Tab;
  profile: Profile;
  /** `null` in flat/compact mode and on iOS — see `TabGroupLayoutProps.renderPanel`. */
  groupId: string | null;
  terminalOpen: boolean;
  filesOpen: boolean;
  isVisible: boolean;
  isFocusedTab: boolean;
  isCompact: boolean;
  actions: TabPanelActions;
}

/**
 * The conversation itself, split from `TabPanel` below so that the dock's
 * own state (a file opened, a terminal added — `terminalTabs`/`fileTabs`,
 * which change identity whenever ANY tab touches them) can't reach it. With
 * both in one component, opening a file in one tab re-rendered every other
 * tab's `ChatPanel`, Tiptap editor included.
 */
const TabChat = memo(function TabChat({
  tab,
  profile,
  groupId,
  terminalOpen,
  filesOpen,
  isVisible,
  isFocusedTab,
  isCompact,
  actions,
}: TabChatProps) {
  const noPanes = isCompact || isIOS();
  return (
    <ChatPanel
      // On iOS (no TabGroupLayout/flat panel layer), the panel is a single
      // JSX slot whose `sessionId` just changes value — without a `key` tied
      // to the session, React reuses the same instance when switching
      // conversations (only updates props), and internal state
      // (useMessageLog etc.) doesn't reset on its own. `onReconnecting`
      // doesn't help here: it only fires on a real reconnection of the SAME
      // RelayClient instance, not when useRelayClient swaps sessionId and
      // creates a new instance. The result was a real bug: clicking "+"
      // would open a genuinely new session (connecting,
      // "Reconnecting"→"Connected") but the screen kept showing the
      // previous conversation's log. On desktop this didn't happen
      // (TabGroupLayout's flat panel layer already has `key={tab.id}` on
      // each tab's panel wrapper) — here it's just made explicit in the
      // same spot.
      key={tab.id}
      profile={profile}
      sessionId={tab.id}
      isNewConversation={tab.isNew}
      onTurnActiveChange={(active) => actions.onTurnActiveChange(tab.id, active)}
      onBackgroundJobsChange={(jobs) => actions.onBackgroundJobsChange(tab.id, jobs)}
      onTurnComplete={(result) => actions.onTurnComplete(tab, profile, result)}
      onTitle={(title) => actions.onTitle(tab, title)}
      onActivity={() => actions.onActivity(tab)}
      onDeleted={() => actions.onDeleted(tab)}
      onConnectedChange={(connected) => actions.onConnectedChange(tab.id, connected)}
      groupId={noPanes ? null : groupId}
      terminal={noPanes ? undefined : { open: terminalOpen, onToggle: () => actions.onTogglePane(tab.id, "terminal") }}
      files={noPanes ? undefined : { open: filesOpen, onToggle: () => actions.onTogglePane(tab.id, "files") }}
      onOpenPath={noPanes ? undefined : (path) => actions.onOpenPath(profile, tab.id, path)}
      isActiveTab={isVisible}
      isFocusedTab={isFocusedTab}
    />
  );
});

interface TabPanelProps extends Omit<TabChatProps, "terminalOpen" | "filesOpen"> {
  /** `terminalOpen`/`filesOpen` are derived from this and handed down, so
   * `TabChat` doesn't take the whole dock — the width and the split ratio
   * move on every frame of a drag, and the conversation has no business
   * re-rendering for either. */
  dock: DockState;
  terminalTabs: ReturnType<typeof useTerminalTabs>;
  fileTabs: ReturnType<typeof useFileTabs>;
}

/**
 * One tab's whole panel: the conversation, plus the terminal/files dock on
 * desktop.
 *
 * `memo` here is what keeps a render of `App` from costing one render per
 * open conversation. Every tab stays mounted at all times (that's what keeps
 * its WS alive), so without this boundary, anything that moves `App`'s state
 * — a tab switch, the sidebar collapsing, a turn starting in some other tab
 * — re-rendered every conversation and every Tiptap editor on screen.
 *
 * It only pays off because each prop above is either a value that genuinely
 * belongs to this tab (`tab`, `profile`, `dock` — all referentially stable
 * while they don't change: see `getDock`, `findProfile`, and the per-tab
 * updates in `useTabs`) or the one `actions` object, built once. Adding a
 * prop that is rebuilt on every render of `App` would silently turn this
 * back into what it replaced.
 */
export const TabPanel = memo(function TabPanel({
  tab,
  profile,
  groupId,
  dock,
  isVisible,
  isFocusedTab,
  isCompact,
  terminalTabs,
  fileTabs,
  actions,
}: TabPanelProps) {
  const chat = (
    <TabChat
      tab={tab}
      profile={profile}
      groupId={groupId}
      terminalOpen={dock.panes.includes("terminal")}
      filesOpen={dock.panes.includes("files")}
      isVisible={isVisible}
      isFocusedTab={isFocusedTab}
      isCompact={isCompact}
      actions={actions}
    />
  );

  if (isCompact || isIOS()) return chat;

  // Embedded terminal and files pane, desktop only.
  // `isVisible` is what implements "switching to another tab in this same
  // group closes the dock on its own, coming back reopens it the way it
  // was": `TabGroupLayout` keeps ALL tabs mounted in the background (its
  // flat panel layer, to keep the chat WS alive — see comment there), so
  // without this gate the dock's panes would stay connected for every
  // backgrounded tab too. Only each group's own visible tab actually mounts
  // `SessionDock`; the others don't even exist in the DOM, so they don't
  // open any terminal/watch WS either. With up to 3 groups now, that means
  // up to 3 live docks at once (up to 3 terminal + 3 watch WS) — not the
  // single live dock this comment used to promise back when there was only
  // ever one active tab in the whole app.
  //
  // The gate here doesn't include `dock.panes.length === 0` — that's how the
  // open/close animation (same as the left sidebar's, useResizableSidebar)
  // works: `SessionDock` stays mounted the whole time the tab is visible,
  // and IT (internally, lightweight) is what decides the width (0 closed,
  // animating to `dock.width` when open). Without this the dock's content
  // only existed in the DOM while open — there was nothing for the CSS
  // transition to animate, it just popped in/out.
  const chatHidden = isVisible && dock.maximized !== null;

  // The wrapper (this `div` + the `div` right below wrapping the chat) is
  // rendered unconditionally, with the SAME shape always — only the presence
  // of `SessionDock` as a sibling toggles (along with the tab becoming
  // active/inactive). Before this it was conditional (`if (!showTerminal)
  // return chatContent` with no wrapper at all), and
  // opening/closing/switching the terminal tab changed the type of the child
  // at that position in the tree (from `ChatPanel` directly to `div`) —
  // React saw that as a different element and unmounted the whole
  // `ChatPanel` (losing `ready`, closing the WS, reconnecting), which is
  // exactly the skeleton flash reported when opening/expanding/closing the
  // panel. Keeping the shape stable avoids that remount.
  return (
    <div className="relative flex h-full min-w-0">
      {/* `invisible absolute inset-0` instead of shrinking to 0 — same
       * trick (and same reason) as `TabGroupLayout.tsx`'s flat panel layer:
       * `MessageLog` uses `@tanstack/react-virtual`, whose `ResizeObserver`
       * corrupts the height cache if the container measures size 0 even
       * briefly (which is exactly what would happen when maximizing a pane
       * if the chat were hidden via `display:none`/zero width). */}
      <div className={cn("min-w-0 flex-1", chatHidden && "invisible absolute inset-0")}>{chat}</div>
      {isVisible && (
        <SessionDock
          dock={dock}
          onWidthChange={(width) => actions.onDockWidthChange(tab.id, width)}
          onSplitRatioChange={(ratio) => actions.onDockSplitRatioChange(tab.id, ratio)}
          onDragEnd={actions.onDockDragEnd}
          panes={{
            terminal: dock.panes.includes("terminal") ? (
              <TerminalPanelSlot
                profile={profile}
                chatSessionId={tab.id}
                maximized={dock.maximized === "terminal"}
                terminalTabs={terminalTabs}
                onToggleMaximized={() => actions.onToggleMaximized(tab.id, "terminal")}
                onClose={() => actions.onClosePane(tab.id, "terminal")}
              />
            ) : undefined,
            files: dock.panes.includes("files") ? (
              <FilesPanelSlot
                profile={profile}
                chatSessionId={tab.id}
                maximized={dock.maximized === "files"}
                fileTabs={fileTabs}
                onToggleMaximized={() => actions.onToggleMaximized(tab.id, "files")}
                onClose={() => actions.onClosePane(tab.id, "files")}
                onOpenTerminal={(path) => actions.onOpenTerminalAt(tab.id, path)}
              />
            ) : undefined,
          }}
        />
      )}
    </div>
  );
});
