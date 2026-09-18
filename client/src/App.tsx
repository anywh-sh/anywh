import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/shell/Sidebar";
import { EmptyState } from "@/components/shell/EmptyState";
import { SessionSearch } from "@/components/shell/SessionSearch";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { TabGroupLayout } from "@/components/shell/TabGroupLayout";
import { TabPanel } from "@/components/shell/TabPanel";
import { TitleBar } from "@/components/shell/TitleBar";
import { StatusBar } from "@/components/shell/StatusBar";
import { MobileShell } from "@/components/shell/MobileShell";
import { RevokedProfileBanners } from "@/components/shell/RevokedProfileBanner";
import { UpdateModal } from "@/components/shell/UpdateModal";
import { ProfileSetupDialog } from "@/components/shell/ProfileSetupDialog";
import { FirstRun } from "@/components/firstrun/FirstRun";
import { DownloadToasts } from "@/components/files/DownloadToasts";
import { useDict } from "@/i18n";
import { useActiveProfile } from "@/hooks/profiles/useActiveProfile";
import { useNavigationHistory } from "@/hooks/useNavigationHistory";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useLayoutCommands } from "@/hooks/useLayoutCommands";
import { useProfileSwitching } from "@/hooks/useProfileSwitching";
import { useSessionActions } from "@/hooks/useSessionActions";
import { useTabPanelActions } from "@/hooks/useTabPanelActions";
import { useSessionNames } from "@/hooks/relay/useSessionNames";
import { useSessionListBootstrap } from "@/hooks/tabs/useSessionListBootstrap";
import { useMergedSessions } from "@/hooks/tabs/useMergedSessions";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useResizableSidebar } from "@/hooks/tabs/useResizableSidebar";
import { useIsCompactViewport } from "@/hooks/platform/useIsCompactViewport";
import { useTabs, type Tab } from "@/hooks/tabs/useTabs";
import { useSessionDock } from "@/hooks/tabs/useSessionDock";
import { useTerminalTabs } from "@/hooks/tabs/useTerminalTabs";
import { useFileTabs } from "@/hooks/tabs/useFileTabs";
import { useWindowFocus } from "@/hooks/platform/useWindowFocus";
import { useNotificationClick } from "@/hooks/platform/useNotificationClick";
import { useContextMenuGuard } from "@/hooks/platform/useContextMenuGuard";
import { useProfileImport } from "@/hooks/profiles/useProfileImport";
import { useProfileSetup } from "@/hooks/profiles/useProfileSetup";
import { useFirstRun } from "@/hooks/useFirstRun";
import { useActiveTheme } from "@/hooks/relay/useThemes";
import { useProfileSync } from "@/hooks/relay/useProfileSync";
import { useTailnetSidecarOwner } from "@/hooks/profiles/useTailnetSidecarOwner";
import { findProfile, getProfiles } from "@/lib/profiles/profiles";
import { pruneCachedProfiles } from "@/lib/format/sessionListCache";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import { dismissProfileSetup, retryProfileSetup } from "@/lib/profiles/profileSetup";
import { ensureNotificationPermission } from "@/lib/platform/notifications";
import { isIOS } from "@/lib/platform/platform";
import { forceUpdateCheck, performUpdateCheck } from "@/lib/install/appUpdate";

/** Optional override via query string (`?profile=&session=`) — only to allow
 * a direct deep-link to a specific state in tests via Playwright. */
function readQueryOverride(): { profile: string | null; session: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { profile: params.get("profile"), session: params.get("session") };
}

/**
 * The gate. The shell below assumes at least one profile exists — every
 * hook that takes `activeProfile` gets a non-nullable `Profile`, and some
 * thirty call sites lean on that — so rather than teach all of them about
 * `null`, nothing under `AppShell` ever mounts without one. Until then the
 * window belongs to the first-run screen.
 *
 * Two halves to the predicate, both needed. The list can be empty while the
 * first run is *not* what should be showing (never, today — but the flag
 * is what makes that a decision rather than an accident), and the first run
 * has to stay up while the list is *not* empty: a profile is saved before
 * it is verified (`claimAndSaveProfile` runs first in profileSetup.ts), so
 * the list stops being empty halfway through the flow, and the wizard would
 * vanish mid-step if the list alone decided. `finishFirstRun` is what ends
 * it.
 *
 * A third clause for the run *after* one that died mid-setup: a device
 * whose only profile is still `unverified` (saved, never reached) opens on
 * the first run again, which resumes that profile's verification, instead
 * of on a shell that can't talk to anything. Only for a sole profile — with
 * others around, the shell works and the unverified one is badged there —
 * and only until the user chooses the shell anyway (`shellChosen`).
 *
 * Lives here and not in `main.tsx` because `tests/ui/helpers/renderApp.tsx`
 * mounts `<App />` directly — a gate above it would sit outside the only
 * tier that can drive this flow by click and keystroke.
 */
export default function App() {
  // Deep-link profile import (`anywh://import-profile`) — see
  // useProfileImport.ts. Only feeds the profileSetup.ts queue; nothing
  // switches profile until the user acts on ProfileSetupDialog, wherever
  // that dialog is mounted (the shell or the first run). Listened for here,
  // above the gate, because a link is most likely to arrive precisely when
  // there is no profile yet — the pairing flow's whole point — and a
  // listener inside the shell would be unmounted at that exact moment.
  useProfileImport();
  const profiles = useProfiles();
  const firstRun = useFirstRun();
  const soleUnverified = profiles.length === 1 && profiles[0].unverified === true;

  if (profiles.length === 0 || firstRun.active || (soleUnverified && !firstRun.shellChosen)) return <FirstRun />;
  return <AppShell />;
}

/** Everything the app is once a profile exists. Never mounted without one —
 * see `App` above. */
function AppShell() {
  const dict = useDict();
  const queryOverride = useMemo(readQueryOverride, []);
  const [activeProfile, setActiveProfileId] = useActiveProfile(queryOverride.profile);
  const { loading: sessionsLoading, error: sessionsError, reload: reloadSessions } = useSessionNames(activeProfile);
  const profiles = useProfiles();
  // One fetch per profile this device has never synced, ever — every other
  // profile's rows come from the cache and are refreshed by whatever
  // connection the app was already making.
  useSessionListBootstrap(activeProfile.id);
  // Which profiles the sidebar shows, deliberately not `activeProfile`:
  // that one means "where work happens" (connection, theme, where a new
  // conversation lands) and already moves on its own when a tab from another
  // profile takes focus. Overloading it with "what am I looking at" would
  // make switching tabs silently change the filter.
  const [selectedProfileIds, setSelectedProfileIds] = useState<ReadonlySet<string>>(
    () => new Set(getProfiles().map((profile) => profile.id)),
  );
  const sessions = useMergedSessions(selectedProfileIds);
  const isCompact = useIsCompactViewport();
  const resizable = useResizableSidebar();
  const tabsState = useTabs();
  const sessionDock = useSessionDock();
  const terminalTabs = useTerminalTabs();
  const fileTabs = useFileTabs();
  const nav = useNavigationHistory();
  const windowFocused = useWindowFocus();
  useContextMenuGuard();
  // Both registry mirrors live here, at the one place that is mounted for
  // the whole life of the app in both layouts. The profile sync used to sit
  // inside ProfileSwitcher, which the collapsible sidebar unmounts and iOS
  // never renders at all — so collapsing the sidebar turned it off and the
  // phone never ran it.
  const { supported: profilesSupported } = useProfileSync(activeProfile);
  // Holds the active profile's tailnet-sidecar reference for as long as it's
  // selected — the sidebar/sync hooks above run against it before any chat
  // tab (the only other thing that used to acquire one) ever mounts for it.
  useTailnetSidecarOwner(activeProfile);

  // The theme is one device-wide choice, so nothing here is scoped to a
  // profile: the catalog the settings dialog offers comes from whichever
  // host this device is connected to, and what gets painted is what the
  // person picked, whatever profile they're reading right now.
  //
  // Mirroring a host's custom themes only matters while the settings dialog
  // can show them, so `useThemeSync` runs there instead (`ThemeSection.tsx`)
  // — keeping it mounted here doubled the keepalive traffic to every host
  // this device talks to, for a catalog nothing was reading between visits.
  useActiveTheme();

  // A profile added (pairing, setup) joins the view; one removed leaves it,
  // along with its cached rows. Reconciled here rather than at each
  // `removeProfile` call site — there are already several, and a persisted
  // cache that stays correct only while every future one remembers to clean
  // up is a bug waiting to be written.
  useEffect(() => {
    const known = new Set(profiles.map((profile) => profile.id));
    pruneCachedProfiles(known);
    setSelectedProfileIds((previous) => {
      const next = new Set([...previous].filter((id) => known.has(id)));
      for (const id of known) if (!previous.has(id)) next.add(id);
      // Every profile deselected would leave an empty sidebar with no way
      // back except the filter menu — fall back to showing everything.
      if (next.size === 0) return known;
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
    });
  }, [profiles]);

  const toggleProfileFilter = useCallback((profileId: string) => {
    setSelectedProfileIds((previous) => {
      const next = new Set(previous);
      // Turning the last one off would show nothing at all — the way to see
      // one profile is to leave one selected, not to select none.
      if (next.has(profileId) && next.size === 1) return previous;
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  }, []);

  const clearProfileFilter = useCallback(() => {
    setSelectedProfileIds(new Set(getProfiles().map((profile) => profile.id)));
  }, []);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  // Connection state per tab — used by TitleBar/MobileTopBar, which
  // live outside ChatPanel. Fed by `renderPanel`'s `onConnectedChange` below.
  // Keyed by tab id (not a single flag) because desktop's TabGroupLayout keeps
  // every tab's ChatPanel mounted at once (its flat panel layer, see the
  // `key={tab.id}` comment in `renderPanel`): a background tab's `connected`
  // can flip while it's not the active one, and nothing re-fires once it becomes active
  // again. A single flag reset to `false` on every tab switch (the previous
  // approach) got stuck showing "Reconectando…" forever for a tab that was
  // already connected, since its `connected` value wasn't changing anymore
  // to trigger another update.
  const [connectedByTab, setConnectedByTab] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  // The app stays open for days, so "check on launch" alone would never fire
  // for someone who never restarts — a 24h interval here, not a one-shot
  // effect, is what makes that case checked at all. Deliberately not inside
  // whatever eventually renders the result, so that stays a trivial,
  // timer-free read of what this already found. No updater exists under the
  // App Store, so this never even probes on iOS — the `app_install_source`/
  // `app_check_latest_release` commands aren't compiled into that build.
  useEffect(() => {
    if (isIOS()) return;
    void performUpdateCheck();
    const interval = setInterval(() => void performUpdateCheck(), 24 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // The title bar menu's "Check for updates" — bypasses the 24h cadence
  // (forceUpdateCheck, same as the removed Settings page's button did) and
  // always opens the modal afterwards, found or not, so a manual check gets
  // an answer instead of silently doing nothing when already up to date.
  async function handleCheckForUpdates(): Promise<void> {
    await forceUpdateCheck();
    setUpdateModalOpen(true);
  }

  // First launch: restores last time's tabs (full list + order + which one
  // was active), across all profiles together. Only runs once,
  // while no tab is open yet. The test deep-link via query string
  // takes priority and still opens only the requested session, in the given
  // profile (or the default one).
  useEffect(() => {
    if (tabsState.tabs.length > 0) return;
    if (queryOverride.session) {
      tabsState.openTab(activeProfile.id, queryOverride.session);
      return;
    }
    const persisted = tabsState.getPersistedTabs();
    if (persisted) tabsState.restoreTabs(persisted.tabs, persisted.activeTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTabId = tabsState.activeTabId;
  // No active tab means no conversation is trying to connect at all — showing
  // "Reconnecting…" on the idle screen would be reporting a disconnect that
  // doesn't exist, since `false` here used to mean "no tab" as much as "really down".
  const activeConnected = activeTabId ? (connectedByTab[activeTabId] ?? false) : true;

  // Clears the "turn complete" badge of the tab that's visible now.
  useEffect(() => {
    if (activeTabId) tabsState.setUnread(activeTabId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Drops `connectedByTab` entries for tabs that no longer exist (closed via
  // any of the several paths that call `closeTab`), so the map doesn't grow
  // unbounded across a long session.
  useEffect(() => {
    const openIds = new Set(tabsState.tabs.map((tab) => tab.id));
    setConnectedByTab((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => openIds.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [tabsState.tabs]);

  // Pushes a history entry (titlebar Back/Forward) every time the
  // active tab changes, except when the change came from goBack/goForward
  // itself (the hook filters that out internally).
  useEffect(() => {
    nav.notifyLocationChanged({ tabId: activeTabId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  function handleGoBack(): void {
    const location = nav.goBack();
    if (location?.tabId) tabsState.setActiveTab(location.tabId);
  }

  function handleGoForward(): void {
    const location = nav.goForward();
    if (location?.tabId) tabsState.setActiveTab(location.tabId);
  }

  // Read side of the deep-link/pairing queue `App` (the gate) feeds — nothing
  // switches profile until the user clicks "Continue" on ProfileSetupDialog
  // below (the old silent auto-switch is gone).
  const setupSnapshot = useProfileSetup();

  const { handleProfileChange, handleSetupContinue, handleSetupUseExisting } = useProfileSwitching({
    setActiveProfileId,
    setDrawerOpen,
    openTab: tabsState.openTab,
    setupSnapshot,
  });

  const {
    handleNewConversation,
    handleNewTabInGroup,
    handleSelectSession,
    focusSession,
    handleSearchSelectSession,
    handleRenameSession,
    handleDeleteSession,
  } = useSessionActions({
    activeProfile,
    selectedProfileIds,
    setActiveProfileId,
    setDrawerOpen,
    dict,
    tabsState,
    sessionDock,
    terminalTabs,
    fileTabs,
  });

  // Click on a turn-complete notification — see useNotificationClick.ts for
  // how each platform delivers this (and the limitation documented there:
  // Windows and iOS work, macOS/Linux desktop has no click hook).
  useNotificationClick(({ sessionId, profileId }) => {
    focusSession(profileId, sessionId);
  });

  const {
    handleCloseActiveTab,
    handleToggleSidebarShortcut,
    handleToggleTerminalPanel,
    handleToggleFilesPanel,
    handleOpenTerminalAt,
    handleOpenFilePath,
    handleCycleTab,
    handleSplitActiveTab,
    handleFocusGroupByIndex,
  } = useLayoutCommands({
    isCompact,
    activeTabId,
    tabsState,
    sessionDock,
    terminalTabs,
    fileTabs,
    resizable,
    setDrawerOpen,
  });

  useKeyboardShortcuts({
    onToggleSearch: () => setSearchOpen((open) => !open),
    onCycleTab: handleCycleTab,
    onToggleTerminal: handleToggleTerminalPanel,
    onToggleFiles: handleToggleFilesPanel,
    onSplitTab: handleSplitActiveTab,
    onNewConversation: handleNewConversation,
    onCloseTab: handleCloseActiveTab,
    onToggleSidebar: handleToggleSidebarShortcut,
    onFocusGroup: handleFocusGroupByIndex,
  });

  // Every profile's running sessions, not just the selected profile's — the
  // sidebar lists them all now, and a turn running in another profile's tab
  // is exactly the kind of thing the indicator exists to surface.
  //
  // Still only covers sessions open as a tab: a session with no tab has no
  // live WS connection to know whether it's running, the same limitation
  // `isRunning` always had.
  const runningSessions = useMemo(
    () => new Set(tabsState.tabs.filter((tab) => tab.isRunning).map((tab) => tab.id)),
    [tabsState.tabs],
  );
  const backgroundJobSessions = useMemo(
    () => new Set(tabsState.tabs.filter((tab) => tab.hasBackgroundJob).map((tab) => tab.id)),
    [tabsState.tabs],
  );

  // Stable identities for the sidebar's callbacks. `Sidebar` is memoized and
  // it renders one row per session across every profile — a few hundred of
  // them for a real install — so a single prop rebuilt per render is enough
  // to make that `memo` do nothing at all. The bodies stay plain function
  // declarations above, closing over whatever they need; the ref is what
  // keeps this indirection from freezing the first render's copy of them.
  const sidebarHandlersRef = useRef({
    handleProfileChange,
    handleSelectSession,
    handleNewConversation,
    handleRenameSession,
    handleDeleteSession,
  });
  sidebarHandlersRef.current = {
    handleProfileChange,
    handleSelectSession,
    handleNewConversation,
    handleRenameSession,
    handleDeleteSession,
  };
  const onProfileChange = useCallback((profileId: string) => sidebarHandlersRef.current.handleProfileChange(profileId), []);
  const onSelectSession = useCallback((session: MergedSession) => sidebarHandlersRef.current.handleSelectSession(session), []);
  const onNewConversation = useCallback(() => sidebarHandlersRef.current.handleNewConversation(), []);
  const onRenameSessionRow = useCallback(
    (session: MergedSession, title: string) => sidebarHandlersRef.current.handleRenameSession(session.profileId, session.id, title),
    [],
  );
  const onDeleteSessionRow = useCallback(
    (session: MergedSession) => sidebarHandlersRef.current.handleDeleteSession(session.profileId, session.id),
    [],
  );

  const sidebarProps = {
    activeProfile,
    profiles,
    profilesSupported,
    onProfileChange,
    selectedProfileIds,
    onToggleProfileFilter: toggleProfileFilter,
    onClearProfileFilter: clearProfileFilter,
    sessions,
    sessionsLoading,
    sessionsError,
    onRetrySessions: reloadSessions,
    selectedSession: activeTabId,
    runningSessions,
    backgroundJobSessions,
    onSelectSession,
    onNewConversation,
    onRenameSession: onRenameSessionRow,
    onDeleteSession: onDeleteSessionRow,
  };

  const activeTab = tabsState.tabs.find((tab) => tab.id === activeTabId);

  // Everything a panel calls back into here, built once. Each callback takes
  // the tab (or profile/path) it acts on as an argument and closes over
  // nothing that changes between renders — that is what lets `TabPanel` be
  // `memo`'d, and `App` stop costing one render per open conversation every
  // time any of its state moves. See the comment on `TabPanelActions`.
  const actions = useTabPanelActions({
    dict,
    activeTabId,
    windowFocused,
    tabsState,
    sessionDock,
    terminalTabs,
    fileTabs,
    onOpenFilePath: handleOpenFilePath,
    onOpenTerminalAt: handleOpenTerminalAt,
    setConnectedByTab,
  });

  // A tab can belong to any profile — each one's `ChatPanel` uses
  // the profile recorded on the tab itself, not the profile currently
  // selected in the sidebar.
  const renderPanel = (tab: Tab) => (
    <TabPanel
      key={tab.id}
      tab={tab}
      profile={findProfile(tab.profileId) ?? getProfiles()[0]}
      dock={sessionDock.getDock(tab.id)}
      // Two different gates, now that a group split can put more than one
      // tab on screen at once: `isVisible` is "this tab is the active one of
      // its own group" (drives panel visibility, dock mounting,
      // MessageLog's scroll re-sync, and the native drag-drop guard) — up to
      // one per group can be true simultaneously. `isFocusedTab` narrows
      // that to "...and that group is also the one the user's actually
      // interacting with right now" (drives unread-badge clearing,
      // TitleBar.connected, nav history) — at most one tab in the whole app.
      isVisible={tabsState.visibleTabIds.has(tab.id)}
      isFocusedTab={tab.id === activeTabId}
      isCompact={isCompact}
      terminalTabs={terminalTabs}
      fileTabs={fileTabs}
      actions={actions}
    />
  );

  // Shared between the desktop shell and iOS — what changes between the two
  // is just the surrounding chrome (TitleBar+Sidebar vs. MobileShell), not
  // how each session gets mounted.
  //
  // `relative` down here isn't about layout — without it, iOS's
  // MobileTopBar/composer `backdrop-filter` doesn't sample the message log
  // on real WebKit (real bug, reproduced via Playwright WebKit).
  // Any `position: static` div in this chain up to `.mobile-canvas` breaks
  // the blur. Don't remove it even though it looks redundant — harmless for
  // desktop (doesn't change position/size of anything).
  const tabsContent = (
    <div className="relative min-h-0 flex-1">
      {tabsState.tabs.length === 0 ? (
        <EmptyState />
      ) : isIOS() ? (
        // iOS: the MVP is one session in focus at a time,
        // without keeping several WebSocket connections alive in parallel in
        // the background — only mounts the active session, without
        // TabGroupLayout's tab mechanism (forceMount/dnd-kit, designed for
        // desktop).
        activeTab && renderPanel(activeTab)
      ) : (
        <TabGroupLayout
          tabs={tabsState.tabs}
          groups={tabsState.groups}
          activeTabId={activeTabId}
          splitEnabled={!isCompact}
          sessionDock={{ getDock: sessionDock.getDock, togglePane: actions.onTogglePane }}
          onSelect={tabsState.setActiveTab}
          onFocusGroup={tabsState.focusGroup}
          onNewTab={handleNewTabInGroup}
          onClose={tabsState.closeTab}
          onMoveTab={tabsState.moveTab}
          onSplitTabToNewGroup={tabsState.splitTabToNewGroup}
          onCommitSizes={tabsState.setGroupSizes}
          onRenameSession={(tabId, title) => {
            const tab = tabsState.tabs.find((t) => t.id === tabId);
            if (tab) handleRenameSession(tab.profileId, tabId, title);
          }}
          onDelete={(tabId) => {
            const tab = tabsState.tabs.find((t) => t.id === tabId);
            if (tab) handleDeleteSession(tab.profileId, tabId);
          }}
          renderPanel={renderPanel}
        />
      )}
    </div>
  );

  // Mounted in both layout branches below — iOS has no `ProfileSwitcher`
  // (the only other UI that used to trigger a profile import) to hang this
  // off of, and the desktop sidebar unmounts entirely while collapsed, same
  // reasoning `RevokedProfileBanners` follows.
  const profileSetupDialog = (
    <ProfileSetupDialog
      state={setupSnapshot.state}
      queuedCount={setupSnapshot.queuedCount}
      onContinue={handleSetupContinue}
      onUseExisting={handleSetupUseExisting}
      onRetry={retryProfileSetup}
      onDismiss={dismissProfileSetup}
    />
  );

  if (isIOS()) {
    return (
      // `h-full`, not `h-screen`/`h-dvh` — both are independent viewport-height
      // calculations that can disagree with the `body { position: fixed; inset: 0 }`
      // hack in index.css (already pinned to the real visible viewport). `h-full`
      // instead inherits that exact box via `#app { height: 100% }` (found live
      // testing `ChoiceCard` clipping/leaving a gap under the composer on iOS).
      <div className="flex h-full w-screen flex-col overflow-hidden bg-background text-foreground">
        <RevokedProfileBanners />
        {profileSetupDialog}
        <SessionSearch open={searchOpen} onOpenChange={setSearchOpen} onSelectSession={handleSearchSelectSession} />
        <MobileShell
          activeProfile={activeProfile}
          profiles={profiles}
          onProfileChange={handleProfileChange}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          onRetrySessions={reloadSessions}
          selectedSession={activeTabId}
          runningSessions={runningSessions}
          backgroundJobSessions={backgroundJobSessions}
          onSelectSession={handleSelectSession}
          onRenameSession={(session, title) => handleRenameSession(session.profileId, session.id, title)}
          onDeleteSession={(session) => handleDeleteSession(session.profileId, session.id)}
          onOpenSearch={() => setSearchOpen(true)}
          title={activeTab?.title ?? dict.common.untitledSession}
          connected={activeConnected}
          onNewConversation={handleNewConversation}
        >
          {tabsContent}
        </MobileShell>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar
        canGoBack={nav.canGoBack}
        canGoForward={nav.canGoForward}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        showSidebarToggle={!isCompact}
        sidebarCollapsed={resizable.collapsed}
        onToggleSidebar={resizable.toggleCollapsed}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCheckForUpdates={() => void handleCheckForUpdates()}
        connected={activeConnected}
      />
      {profileSetupDialog}
      <DownloadToasts />

      <SessionSearch open={searchOpen} onOpenChange={setSearchOpen} onSelectSession={handleSearchSelectSession} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        activeProfile={activeProfile}
        profilesSupported={profilesSupported}
      />
      <UpdateModal open={updateModalOpen} onOpenChange={setUpdateModalOpen} />

      <div className="flex min-h-0 flex-1">
        {!isCompact && (
          <div
            className="relative flex shrink-0 border-r border-border-soft"
            style={{ width: resizable.width }}
          >
            <div className="min-w-0 flex-1 overflow-hidden">
              {!resizable.collapsed && <Sidebar {...sidebarProps} />}
            </div>
            {!resizable.collapsed && (
              <div
                onPointerDown={resizable.startDrag}
                className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-border"
              />
            )}
          </div>
        )}

        {isCompact && (
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent side="left" className="w-[280px] gap-0 border-r border-border-soft bg-bg-sidebar p-0 sm:max-w-[280px]">
              <SheetTitle className="sr-only">{dict.shell.sidebar.label}</SheetTitle>
              <Sidebar {...sidebarProps} />
            </SheetContent>
          </Sheet>
        )}

        {/* Inside the main column, not above it: the notice is about a
         * profile's connection, and the conversation and panels are what
         * stop working. The session list keeps working — its rows are cached
         * locally and still readable — so covering it would claim otherwise. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <RevokedProfileBanners />
          {isCompact && (
            <div className="flex items-center gap-2 p-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(true)} aria-label={dict.shell.titleBar.openSidebar}>
                    <Menu className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{dict.shell.titleBar.openSidebar}</TooltipContent>
              </Tooltip>
            </div>
          )}

          {tabsContent}
        </div>
      </div>

      {/* Desktop only, like the title bar it mirrors: iOS has no window
       * chrome to frame, and the mobile shell is out of the redesign's scope
       * (decision 1 of the plan). Reads the focused tab straight from `App`'s
       * own state — see StatusBar.tsx for why this one needs no portal. */}
      <StatusBar
        profile={activeTab ? (findProfile(activeTab.profileId) ?? null) : null}
        sessionId={activeTab?.id ?? null}
        isRunning={activeTab?.isRunning ?? false}
        windowFocused={windowFocused}
        onOpenUpdateModal={() => setUpdateModalOpen(true)}
      />
    </div>
  );
}
