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
import { TabPanel, type TabPanelActions } from "@/components/shell/TabPanel";
import { TitleBar } from "@/components/shell/TitleBar";
import { StatusBar } from "@/components/shell/StatusBar";
import { MobileShell } from "@/components/shell/MobileShell";
import { RevokedProfileBanners } from "@/components/shell/RevokedProfileBanner";
import { UpdateModal } from "@/components/shell/UpdateModal";
import { ProfileSetupDialog } from "@/components/shell/ProfileSetupDialog";
import { FirstRun } from "@/components/firstrun/FirstRun";
import { DownloadToasts } from "@/components/files/DownloadToasts";
import { useDict } from "@/i18n";
import { useActiveProfile } from "@/hooks/useActiveProfile";
import { useNavigationHistory } from "@/hooks/useNavigationHistory";
import { useSessionNames } from "@/hooks/useSessionNames";
import { useSessionListBootstrap } from "@/hooks/useSessionListBootstrap";
import { useMergedSessions } from "@/hooks/useMergedSessions";
import { useProfiles } from "@/hooks/useProfiles";
import { useResizableSidebar } from "@/hooks/useResizableSidebar";
import { useIsCompactViewport } from "@/hooks/useIsCompactViewport";
import { useTabs, type Tab } from "@/hooks/useTabs";
import { useSessionDock } from "@/hooks/useSessionDock";
import { useTerminalTabs } from "@/hooks/useTerminalTabs";
import { useFileTabs } from "@/hooks/useFileTabs";
import { useWindowFocus } from "@/hooks/useWindowFocus";
import { useNotificationClick } from "@/hooks/useNotificationClick";
import { useContextMenuGuard } from "@/hooks/useContextMenuGuard";
import { useProfileImport } from "@/hooks/useProfileImport";
import { useProfileSetup } from "@/hooks/useProfileSetup";
import { useFirstRun } from "@/hooks/useFirstRun";
import { useActiveTheme } from "@/hooks/useThemes";
import { useProfileSync } from "@/hooks/useProfileSync";
import { useTailnetSidecarOwner } from "@/hooks/useTailnetSidecarOwner";
import { addProfile, findProfile, getProfiles, removeProfile, type Profile } from "@/lib/profiles";
import { clearProfileRevoked, isProfileRevoked } from "@/lib/profileRevocation";
import {
  pruneCachedProfiles,
  removeCachedSession,
  touchCachedSession,
  upsertCachedSession,
} from "@/lib/sessionListCache";
import type { MergedSession } from "@/lib/sessionGrouping";
import { completeProfileSetup, dismissProfileSetup, retryProfileSetup } from "@/lib/profileSetup";
import { resolveChatPath } from "@/lib/filesClient";
import { resolveConnection } from "@/lib/connectionResolver";
import { ensureNotificationPermission, notifyTurnComplete } from "@/lib/notifications";
import { deleteSession, renameSession } from "@/lib/relayClient";
import { isIOS } from "@/lib/platform";
import { forceUpdateCheck, performUpdateCheck } from "@/lib/appUpdate";

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

  // Global search shortcut (Ctrl/Cmd+K), on any screen.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  function handleProfileChange(profileId: string): void {
    setActiveProfileId(profileId);
    setDrawerOpen(false);
  }

  /** "Continuar para novo perfil" on `ProfileSetupDialog` — the only place
   * that ever switches to a profile `enqueueProfileSetup` just set up.
   * Order matters: `handleProfileChange` runs first so React has already
   * scheduled the render that makes `useTailnetSidecarOwner` reclaim the
   * tailnet-sidecar reference `profileSetup.ts` is about to hand over,
   * before `completeProfileSetup` releases it (with `HANDOVER_GRACE_MS` to
   * spare). `tabsState.openTab` takes `profileId` explicitly rather than
   * going through `handleNewConversation` — that one reads
   * `activeProfile.id` from the closure, which still has the old value in
   * this same tick. */
  function handleSetupContinue(profileId: string): void {
    handleProfileChange(profileId);
    tabsState.openTab(profileId, crypto.randomUUID(), null, true);
    completeProfileSetup();
  }

  /** "Ir para o perfil existente" on `ProfileSetupDialog`'s duplicate
   * notice — decision 4: normally just drops the freshly claimed duplicate
   * profile, but if the existing one was revoked, migrates the fresh
   * credentials onto its id first (`addProfile` replaces in place) so a
   * dismissed `RevokedProfileBanner` doesn't leave that profile stuck dead.
   * `removeProfile` refusing to empty the list is never a concern here — a
   * duplicate existing means there are already at least two profiles.
   * Ends the setup request via `dismissProfileSetup` (not `completeProfileSetup`):
   * the just-claimed profile is being thrown away, not adopted, so its held
   * tailnet-sidecar reference (if any) should be released right away, with
   * no handover grace. */
  function handleSetupUseExisting(existingId: string): void {
    if (setupSnapshot.state?.status !== "ready") return;
    const newProfile = setupSnapshot.state.profile;

    if (isProfileRevoked(existingId)) {
      addProfile({ ...newProfile, id: existingId });
      clearProfileRevoked(existingId);
    }
    removeProfile(newProfile.id);

    dismissProfileSetup();
    handleProfileChange(existingId);
    tabsState.openTab(existingId, crypto.randomUUID(), null, true);
  }

  // Creates the session implicitly: opens a blank tab right away, without
  // asking for a name — the title is inferred from the first prompt the user
  // sends (the relay fires this in parallel with the turn, see
  // sessionManager.ts). The session only enters the sidebar once that title
  // arrives (ChatPanel's onTitle below), not before.
  function handleNewConversation(): void {
    const id = crypto.randomUUID();
    // Filtered down to exactly one profile, that profile is unambiguously
    // the one being worked in, so a new conversation belongs there. With
    // several selected there is nothing to infer from, and it falls back to
    // the focused tab's profile as before.
    const [onlySelected] = selectedProfileIds;
    const target = selectedProfileIds.size === 1 ? onlySelected : activeProfile.id;
    tabsState.openTab(target, id, null, true);
    setDrawerOpen(false);
  }

  /** The `+` on a group's tab strip. `openTab` always appends to the focused
   * group, so clicking `+` on a strip that isn't focused would otherwise
   * open the tab in the other column. Focusing first works in one click
   * because both are functional updaters on the same `useTabs` state: React
   * batches them and `openTab`'s updater already sees the new
   * `focusedGroupId` — no second render needed in between. */
  function handleNewTabInGroup(groupId: string): void {
    tabsState.focusGroup(groupId);
    handleNewConversation();
  }

  /** A row in the sidebar can belong to any profile now, so this goes
   * through `focusSession` — the same path search and notification clicks
   * already used for "jump to a session that may not be in the current
   * profile". `openTab` records the profile on the tab but does not move
   * `activeProfile` on its own, and leaving that behind would keep the live
   * `/sessions/watch` socket, the tailnet-sidecar reference and the default
   * target for a new conversation pointing at the profile the user just
   * navigated away from. */
  function handleSelectSession(session: MergedSession): void {
    focusSession(session.profileId, session.id, session.title);
    setDrawerOpen(false);
  }

  /** Switches profile (sidebar) + opens/activates the tab — used both by
   * session search (Cmd/Ctrl+K) and by clicking a notification
   * (`useNotificationClick` below), the two cases of "jump straight to a
   * session that may not belong to the currently selected profile". */
  function focusSession(profileId: string, sessionId: string, title: string | null = null): void {
    setActiveProfileId(profileId);
    tabsState.openTab(profileId, sessionId, title);
  }

  function handleSearchSelectSession(profileId: string, sessionId: string, title: string): void {
    focusSession(profileId, sessionId, title);
  }

  // Click on a turn-complete notification — see useNotificationClick.ts for
  // how each platform delivers this (and the limitation documented there:
  // Windows and iOS work, macOS/Linux desktop has no click hook).
  useNotificationClick(({ sessionId, profileId }) => {
    focusSession(profileId, sessionId);
  });

  // Read side of the deep-link/pairing queue `App` (the gate) feeds — nothing
  // switches profile until the user clicks "Continue" on ProfileSetupDialog
  // below (the old silent auto-switch is gone).
  const setupSnapshot = useProfileSetup();

  /** Explicit `profileId` (not always `activeProfile`) for the same reason as
   * `handleDeleteSession` right below: it's also called from a tab belonging
   * to a profile other than the one currently selected in the sidebar. */
  function handleRenameSession(profileId: string, id: string, title: string): void {
    const profile = findProfile(profileId);
    if (!profile) return;
    resolveConnection(profile)
      .then(({ host, port, token }) => renameSession(host, port, id, title, token))
      .then(() => {
        tabsState.setTabTitle(id, title);
        upsertCachedSession(profileId, id, title);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to rename session", error);
        window.alert(dict.shell.sidebar.renameFailed);
      });
  }

  /** Only removes the session from anywh's control — doesn't delete the
   * transcript that Claude Code already keeps on its own. Explicit
   * `profileId` (not always `activeProfile`) because it's also called from a
   * tab belonging to a profile other than the one currently selected in the
   * sidebar. */
  function handleDeleteSession(profileId: string, id: string): void {
    const profile = findProfile(profileId);
    if (!profile) return;
    resolveConnection(profile)
      .then(({ host, port, token }) => deleteSession(host, port, id, token))
      .then(() => {
        tabsState.closeTab(id);
        sessionDock.removeSession(id);
        terminalTabs.removeSession(id);
        fileTabs.removeSession(id);
        removeCachedSession(profileId, id);
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to delete session", error);
        window.alert(dict.shell.sidebar.deleteFailed);
      });
  }

  function handleCloseActiveTab(): void {
    if (!activeTabId) return;
    tabsState.closeTab(activeTabId);
  }

  function handleToggleSidebarShortcut(): void {
    if (isCompact) {
      setDrawerOpen((open) => !open);
    } else {
      resizable.toggleCollapsed();
    }
  }

  // Embedded terminal — desktop only (the original screenshot/flow
  // is clearly desktop, iOS is left out for now, same gate that voice/titlebar
  // already use).
  function handleToggleTerminalPanel(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    sessionDock.togglePane(activeTabId, "terminal");
  }

  // Work dir file panel — same desktop-only gate as the terminal.
  function handleToggleFilesPanel(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    sessionDock.togglePane(activeTabId, "files");
  }

  /** "Open in terminal" on a folder row in the file tree — always a fresh
   * tab (never reuses/clobbers one the user might already be typing in),
   * rooted at that folder. `openPane` (not `togglePane`) because this only
   * ever means "show me this", never "close it" — same desktop-only gate as
   * the terminal panel itself. */
  function handleOpenTerminalAt(tabId: string, path: string): void {
    if (isCompact || isIOS()) return;
    sessionDock.openPane(tabId, "terminal");
    terminalTabs.addTerminal(tabId, path);
  }

  /** A path mentioned in assistant chat text (`Message.tsx`'s `AssistantText`)
   * — same "always show it" gate/`openPane` as `handleOpenTerminalAt` above.
   * Resolution (bare-filename search, ancestor walk for a wrong last
   * segment) runs server-side (`relay/src/fsFiles.ts::resolveChatPath`) —
   * `existingDirs` gets expanded in the tree regardless of whether `target`
   * panned out, so a path that's slightly off still lands the user
   * somewhere browsable instead of just failing silently. */
  function handleOpenFilePath(profile: Profile, tabId: string, rawPath: string): void {
    if (isCompact || isIOS()) return;
    sessionDock.openPane(tabId, "files");
    resolveChatPath(profile, tabId, rawPath)
      .then(({ target, isDirectory, existingDirs }) => {
        if (existingDirs.length > 0) fileTabs.expandDirs(tabId, existingDirs);
        if (target && !isDirectory) fileTabs.openPreview(tabId, target);
      })
      .catch(() => {});
  }

  // Ctrl+Tab / Ctrl+Shift+Tab, like a browser — intentionally only `ctrlKey`,
  // not `metaKey || ctrlKey` like the other shortcuts below: on macOS Cmd+Tab
  // is the OS's own app switcher (never reaches the app), so the real
  // convention for cycling tabs there is also literal Ctrl+Tab, same as
  // browser/VS Code — using `metaKey` here would just create a dead shortcut.
  // Cycles within the focused group only — with more than one group open,
  // cycling through every tab in the app regardless of which group it's in
  // would jump the view to a different group out from under Ctrl+Tab, which
  // isn't what "next tab" means once tabs are split into columns.
  function handleCycleTab(direction: 1 | -1): void {
    const focusedGroup = tabsState.groups.find((group) => group.id === tabsState.focusedGroupId);
    if (!focusedGroup || focusedGroup.tabIds.length < 2) return;
    const currentIndex = focusedGroup.tabIds.indexOf(focusedGroup.activeTabId ?? "");
    if (currentIndex === -1) return;
    const nextIndex = (currentIndex + direction + focusedGroup.tabIds.length) % focusedGroup.tabIds.length;
    tabsState.setActiveTab(focusedGroup.tabIds[nextIndex]);
  }

  // `Ctrl+\` (VS Code's own "split editor") — moves the focused group's
  // active tab into a new group immediately to its right. Desktop only, same
  // gate as the dock: on compact/iOS there's only ever one group (point 12
  // of the split design — narrow viewports fall back to one flat strip), so
  // splitting wouldn't have anywhere to put a second column anyway.
  function handleSplitActiveTab(): void {
    if (isCompact || isIOS() || !activeTabId) return;
    tabsState.splitTabToNewGroup(activeTabId, tabsState.focusedGroupId);
  }

  // Ctrl+1/2/3 — focuses the Nth group left to right. No-op past however
  // many groups are actually open (never more than MAX_GROUPS anyway).
  function handleFocusGroupByIndex(index: number): void {
    const group = tabsState.groups[index];
    if (group) tabsState.focusGroup(group.id);
  }

  // Standard shortcuts for any app (Ctrl on Windows/Linux and Cmd on macOS,
  // via metaKey || ctrlKey): new (N), close current tab (W), show/hide side
  // panel (B). Terminal (Ctrl+`) is handled separately, see the comment
  // inside the handler.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        handleCycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      // `Ctrl+\`` — literal Ctrl even on macOS, never `metaKey`: it's VS
      // Code's own convention (Cmd+` on macOS is already an OS shortcut for
      // switching between windows of the same app), same reason as
      // `Ctrl+Tab` above. Intentionally left out of the switch below, which
      // is only `metaKey || ctrlKey`.
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        handleToggleTerminalPanel();
        return;
      }
      // `Ctrl+Shift+E` — VS Code's own Explorer shortcut, literal Ctrl even
      // on macOS, same reasoning as `Ctrl+\`` right above.
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        handleToggleFilesPanel();
        return;
      }
      // `Ctrl+\` — VS Code's own "split editor" shortcut, literal Ctrl even
      // on macOS, same reasoning as `Ctrl+\`` above (distinct key: backslash,
      // not backtick).
      if (event.ctrlKey && event.key === "\\") {
        event.preventDefault();
        handleSplitActiveTab();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      switch (event.key.toLowerCase()) {
        case "n":
          event.preventDefault();
          handleNewConversation();
          break;
        case "w":
          event.preventDefault();
          handleCloseActiveTab();
          break;
        case "b":
          event.preventDefault();
          handleToggleSidebarShortcut();
          break;
        case "1":
        case "2":
        case "3":
          event.preventDefault();
          handleFocusGroupByIndex(Number(event.key) - 1);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeProfile.id,
    sessionDock.togglePane,
    activeTabId,
    isCompact,
    tabsState.closeTab,
    tabsState.openTab,
    tabsState.setActiveTab,
    tabsState.splitTabToNewGroup,
    tabsState.focusGroup,
    tabsState.focusedGroupId,
    tabsState.groups,
    resizable.toggleCollapsed,
  ]);

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

  // Read by `actions` below at the moment something actually happens (a turn
  // finishing, a path being opened from chat text), never at the moment the
  // callback was built — which is what keeps that object stable across
  // renders without any of it going stale. `handleOpenFilePath` and
  // `handleOpenTerminalAt` are plain function declarations, re-created every
  // render; the two values are just state that moves on its own.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const windowFocusedRef = useRef(windowFocused);
  windowFocusedRef.current = windowFocused;
  const handleOpenFilePathRef = useRef(handleOpenFilePath);
  handleOpenFilePathRef.current = handleOpenFilePath;
  const handleOpenTerminalAtRef = useRef(handleOpenTerminalAt);
  handleOpenTerminalAtRef.current = handleOpenTerminalAt;

  // Everything a panel calls back into here, built once. Each callback takes
  // the tab (or profile/path) it acts on as an argument and closes over
  // nothing that changes between renders — that is what lets `TabPanel` be
  // `memo`'d, and `App` stop costing one render per open conversation every
  // time any of its state moves. See the comment on `TabPanelActions`.
  const actions = useMemo<TabPanelActions>(
    () => ({
      onTurnActiveChange: (tabId, active) => tabsState.setRunning(tabId, active),
      onBackgroundJobsChange: (tabId, jobs) => tabsState.setHasBackgroundJob(tabId, jobs.length > 0),
      onTurnComplete: (tab, profile, { stopped, lastUserText, lastAssistantText }) => {
        // Read through refs, not captured: this runs when a turn finishes,
        // which is arbitrarily long after the render that built this
        // object, and both values move on their own in the meantime.
        // Capturing them would mean notifying (or staying silent) based on
        // where the user was, not where they are.
        const stillVisible = tab.id === activeTabIdRef.current && windowFocusedRef.current;
        if (stillVisible) return;
        tabsState.setUnread(tab.id, true);
        notifyTurnComplete(tab.id, profile, tab.title ?? dict.common.untitledSession, lastUserText, lastAssistantText, stopped);
      },
      onTitle: (tab, title) => {
        tabsState.setTabTitle(tab.id, title);
        // Ungated on the active profile, unlike before: with every profile
        // in one list, a conversation titled in a background tab has to
        // appear under its own profile whether or not that profile is the
        // one currently selected.
        upsertCachedSession(tab.profileId, tab.id, title, Date.now());
      },
      onActivity: (tab) => {
        touchCachedSession(tab.profileId, tab.id);
      },
      onDeleted: (tab) => {
        tabsState.closeTab(tab.id);
        sessionDock.removeSession(tab.id);
        terminalTabs.removeSession(tab.id);
        fileTabs.removeSession(tab.id);
        removeCachedSession(tab.profileId, tab.id);
      },
      onConnectedChange: (tabId, connected) => {
        setConnectedByTab((prev) => (prev[tabId] === connected ? prev : { ...prev, [tabId]: connected }));
      },
      onTogglePane: (tabId, kind) => sessionDock.togglePane(tabId, kind),
      onClosePane: (tabId, kind) => sessionDock.closePane(tabId, kind),
      onToggleMaximized: (tabId, kind) => sessionDock.toggleMaximized(tabId, kind),
      onOpenPath: (profile, tabId, path) => handleOpenFilePathRef.current(profile, tabId, path),
      onOpenTerminalAt: (tabId, path) => handleOpenTerminalAtRef.current(tabId, path),
      onDockWidthChange: (tabId, width) => sessionDock.setWidth(tabId, width),
      onDockSplitRatioChange: (tabId, ratio) => sessionDock.setSplitRatio(tabId, ratio),
      onDockDragEnd: () => sessionDock.commitDock(),
    }),
    [
      dict,
      tabsState.setRunning,
      tabsState.setHasBackgroundJob,
      tabsState.setUnread,
      tabsState.setTabTitle,
      tabsState.closeTab,
      sessionDock.removeSession,
      sessionDock.togglePane,
      sessionDock.closePane,
      sessionDock.toggleMaximized,
      sessionDock.setWidth,
      sessionDock.setSplitRatio,
      sessionDock.commitDock,
      terminalTabs.removeSession,
      fileTabs.removeSession,
    ],
  );

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
