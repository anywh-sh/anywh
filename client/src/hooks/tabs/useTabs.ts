import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProfiles } from "@/lib/profiles/profiles";

export interface Tab {
  id: string;
  profileId: string;
  /** `null` until the title is inferred from the first prompt — the tab shows a
   * generic placeholder in the meantime (see TabGroupStrip). */
  title: string | null;
  hasUnreadCompletion: boolean;
  isRunning: boolean;
  /** Has an `anywh-bg` job currently observed in this session —
   * same pattern as `isRunning`, but for "something running unsupervised in
   * parallel" instead of "the assistant is responding right now". */
  hasBackgroundJob: boolean;
  /** `true` only for tabs opened via "new conversation" — used by ChatPanel
   * to show the idle state instead of the loading skeleton while
   * there's no message yet: there's no history to wait for. Stays `true`
   * for the rest of the tab's life, but is only consulted while the log is
   * empty, so it loses effect on its own after the first message. */
  isNew: boolean;
}

/** One column of the split — up to `MAX_GROUPS` side by side (see the
 * "split de grupos" journal entry for the full design). `tabIds` is the
 * group's own visual order, independent of `tabs`' pool order below. */
export interface TabGroup {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
  /** Fraction of the content area's width — every group's `size` sums to 1. */
  size: number;
}

interface TabsState {
  /** Flat pool, unordered w.r.t. display — every consumer that doesn't care
   * about visual order (running/background-job lookups, the `tabId -> Tab`
   * map) keeps reading this directly, same as before groups existed. Visual
   * order lives on each `TabGroup.tabIds` instead. */
  tabs: Tab[];
  /** Left to right. Always at least one — a fully "empty" app is one group
   * with `tabIds: []`, never zero groups. */
  groups: TabGroup[];
  focusedGroupId: string;
}

interface PersistedTab {
  id: string;
  profileId: string;
  title: string | null;
}

interface PersistedTabs {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

interface PersistedTabGroup {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
  size: number;
}

interface PersistedTabLayout {
  version: 1;
  groups: PersistedTabGroup[];
  focusedGroupId: string;
}

export const MAX_GROUPS = 3;
const MIN_GROUP_SIZE = 0.05;

/** Share a freshly split-off group starts with — matches `TabGroupLayout`'s
 * `EdgeDropZone` tint (`w-2/5`), so the group that actually lands is the same
 * size as the area the drag promised, not whatever `normalizeSizes`' even-split
 * fallback would have produced. */
const NEW_GROUP_SIZE = 0.4;

const TABS_KEY = "anywh:tabs";
const ACTIVE_TAB_KEY = "anywh:active-tab";
const TAB_LAYOUT_KEY = "anywh:tab-layout";

/** Keys from when tabs were separated by profile — used
 * only as a migration fallback for whoever already had tabs saved from before the
 * merge into a single tab strip. */
function legacyTabsKey(profileId: string): string {
  return `anywh:tabs:${profileId}`;
}
function legacyLastSessionKey(profileId: string): string {
  return `anywh:last-session:${profileId}`;
}

/** Format saved before the id/title split: array of strings, where the
 * string was both the id and the displayed title. */
function isLegacyPersistedTabs(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Reads the old format (one tab list per profile) and returns everything already
 * combined into a single list, each tab tagged with the `profileId` it came from.
 * Only runs when the new key (`TABS_KEY`) doesn't exist yet. */
function migrateLegacyTabs(): PersistedTabs | null {
  const allTabs: PersistedTab[] = [];
  let activeTabId: string | null = null;

  for (const profile of getProfiles()) {
    const raw = localStorage.getItem(legacyTabsKey(profile.id));
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const tabs: PersistedTab[] = isLegacyPersistedTabs(parsed)
        ? parsed.map((name) => ({ id: name, profileId: profile.id, title: name }))
        : (parsed as Array<{ id: string; title: string | null }>).map((tab) => ({ ...tab, profileId: profile.id }));
      allTabs.push(...tabs);
      const lastSession = localStorage.getItem(legacyLastSessionKey(profile.id));
      if (activeTabId === null && lastSession && tabs.some((tab) => tab.id === lastSession)) {
        activeTabId = lastSession;
      }
    } catch {
      // ignores a corrupted blob for one profile, continues with the others
    }
  }

  return allTabs.length > 0 ? { tabs: allTabs, activeTabId } : null;
}

function createGroup(tabIds: string[] = [], activeTabId: string | null = null, size = 1): TabGroup {
  return { id: crypto.randomUUID(), tabIds, activeTabId, size };
}

function initialState(): TabsState {
  const group = createGroup();
  return { tabs: [], groups: [group], focusedGroupId: group.id };
}

function findGroupOfTab(groups: TabGroup[], tabId: string): TabGroup | undefined {
  return groups.find((group) => group.tabIds.includes(tabId));
}

/** Scales every group's `size` so they sum to 1, flooring each at
 * `MIN_GROUP_SIZE` first — a group that lost its share (e.g. freshly split
 * off with `size: 0`) still ends up with a usable sliver instead of vanishing,
 * and the floor never breaks the sum-to-1 invariant since it's applied
 * before the final scale. */
function normalizeSizes(groups: TabGroup[]): TabGroup[] {
  if (groups.length === 0) return groups;
  const evenSize = 1 / groups.length;
  const rawSizes = groups.map((group) => (Number.isFinite(group.size) && group.size > 0 ? group.size : evenSize));
  const rawTotal = rawSizes.reduce((sum, size) => sum + size, 0);
  const flooredSizes = rawSizes.map((size) => Math.max(MIN_GROUP_SIZE, size / rawTotal));
  const flooredTotal = flooredSizes.reduce((sum, size) => sum + size, 0);
  return groups.map((group, index) => ({ ...group, size: flooredSizes[index] / flooredTotal }));
}

/** The single choke point every operation below routes its result through —
 * keeps the invariants true no matter which combination of ops produced the
 * new state: always >=1 group, no tab in two groups (or missing from all of
 * them), no empty group unless it's the only one, sizes summing to 1,
 * `focusedGroupId` pointing at a real group, and each group's `activeTabId`
 * one of its own `tabIds`. */
function normalize(state: TabsState): TabsState {
  const poolIds = new Set(state.tabs.map((tab) => tab.id));
  const seen = new Set<string>();

  let groups = state.groups.map((group) => ({
    ...group,
    tabIds: group.tabIds.filter((id) => {
      if (!poolIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  }));

  // Any pool tab that didn't land in any group (shouldn't happen from a
  // correctly-written op, but a persisted blob could be hand-edited) goes
  // into the first group rather than being silently dropped.
  const orphanIds = state.tabs.map((tab) => tab.id).filter((id) => !seen.has(id));
  if (orphanIds.length > 0) {
    if (groups.length === 0) groups = [createGroup()];
    groups = groups.map((group, index) => (index === 0 ? { ...group, tabIds: [...group.tabIds, ...orphanIds] } : group));
  }

  groups = groups.filter((group, index) => group.tabIds.length > 0 || (index === 0 && groups.length === 1));
  if (groups.length === 0) groups = [createGroup()];

  groups = normalizeSizes(groups).map((group) => ({
    ...group,
    activeTabId: group.activeTabId && group.tabIds.includes(group.activeTabId) ? group.activeTabId : (group.tabIds[group.tabIds.length - 1] ?? null),
  }));

  const focusedGroupId = groups.some((group) => group.id === state.focusedGroupId) ? state.focusedGroupId : groups[0].id;

  return { tabs: state.tabs, groups, focusedGroupId };
}

function sanitizeTabIds(tabIds: unknown, poolIds: Set<string>, seen: Set<string>): string[] {
  if (!Array.isArray(tabIds)) return [];
  const result: string[] = [];
  for (const id of tabIds) {
    if (typeof id !== "string" || !poolIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function fallbackLayout(tabs: PersistedTab[], activeTabId: string | null): { groups: TabGroup[]; focusedGroupId: string } {
  const resolvedActiveTabId = activeTabId && tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[tabs.length - 1]?.id ?? null);
  const group = createGroup(
    tabs.map((tab) => tab.id),
    resolvedActiveTabId,
  );
  return { groups: [group], focusedGroupId: group.id };
}

/** Reads `anywh:tab-layout`, defensively — a blob referencing a `tabId` no
 * longer in the pool, a corrupted/absent blob, or one predating this key
 * (`version` missing) all fall back to a single group holding every tab in
 * `tabs`' persisted order. That's also exactly what a user upgrading from
 * before this feature sees on first boot. */
function getPersistedLayout(tabs: PersistedTab[], fallbackActiveTabId: string | null): { groups: TabGroup[]; focusedGroupId: string } {
  const raw = localStorage.getItem(TAB_LAYOUT_KEY);
  if (raw === null) return fallbackLayout(tabs, fallbackActiveTabId);

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedTabLayout>;
    if (parsed.version !== 1 || !Array.isArray(parsed.groups)) return fallbackLayout(tabs, fallbackActiveTabId);

    const poolIds = new Set(tabs.map((tab) => tab.id));
    const seen = new Set<string>();
    const groups: TabGroup[] = parsed.groups
      .map((group) => {
        const tabIds = sanitizeTabIds(group?.tabIds, poolIds, seen);
        const activeTabId = typeof group?.activeTabId === "string" && tabIds.includes(group.activeTabId) ? group.activeTabId : (tabIds[tabIds.length - 1] ?? null);
        return {
          id: typeof group?.id === "string" ? group.id : crypto.randomUUID(),
          tabIds,
          activeTabId,
          size: typeof group?.size === "number" ? group.size : 0,
        };
      })
      .filter((group) => group.tabIds.length > 0);

    if (groups.length === 0) return fallbackLayout(tabs, fallbackActiveTabId);

    const focusedGroupId = groups.some((group) => group.id === parsed.focusedGroupId) ? (parsed.focusedGroupId as string) : groups[0].id;
    return { groups, focusedGroupId };
  } catch {
    return fallbackLayout(tabs, fallbackActiveTabId);
  }
}

/**
 * State of the whole app's tabs, now grouped into side-by-side
 * columns for the split feature: `tabs` stays the flat pool (no separation
 * by profile — each tab carries its own `profileId`), while `groups` holds
 * the left-to-right visual layout. All tabs stay mounted at all times (WS
 * connection alive even in the background), same as before groups existed.
 */
export function useTabs() {
  const [state, setState] = useState<TabsState>(initialState);
  // Becomes `true` as soon as the list stops being the initial mount
  // placeholder (via restoration or first tab opened) — prevents the persistence
  // effect below from writing an empty layout over what was already saved before
  // `App` runs the restoration effect (which runs after this one, see hook
  // ordering).
  const hydratedRef = useRef(false);
  // Mirror of the committed state, for the "would this change anything?"
  // guards in `setActiveTab`/`focusGroup` below. They have to answer that
  // question BEFORE calling `setState`, which is why reading `state` through
  // a ref is necessary and reading it inside the updater is not enough — see
  // the comment on `focusGroup`.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!hydratedRef.current) return;
    const persistedTabs: PersistedTab[] = state.tabs.map((tab) => ({ id: tab.id, profileId: tab.profileId, title: tab.title }));
    localStorage.setItem(TABS_KEY, JSON.stringify(persistedTabs));
    const focusedGroup = state.groups.find((group) => group.id === state.focusedGroupId);
    if (focusedGroup?.activeTabId) localStorage.setItem(ACTIVE_TAB_KEY, focusedGroup.activeTabId);

    const layout: PersistedTabLayout = {
      version: 1,
      groups: state.groups.map((group) => ({ id: group.id, tabIds: group.tabIds, activeTabId: group.activeTabId, size: group.size })),
      focusedGroupId: state.focusedGroupId,
    };
    localStorage.setItem(TAB_LAYOUT_KEY, JSON.stringify(layout));
  }, [state]);

  const openTab = useCallback((profileId: string, id: string, title: string | null = null, isNew = false) => {
    hydratedRef.current = true;
    setState((prev) => {
      const existingGroup = findGroupOfTab(prev.groups, id);
      if (existingGroup) {
        return {
          ...prev,
          groups: prev.groups.map((group) => (group.id === existingGroup.id ? { ...group, activeTabId: id } : group)),
          focusedGroupId: existingGroup.id,
        };
      }

      const tabs = [...prev.tabs, { id, profileId, title, hasUnreadCompletion: false, isRunning: false, hasBackgroundJob: false, isNew }];
      const groups = prev.groups.map((group) => (group.id === prev.focusedGroupId ? { ...group, tabIds: [...group.tabIds, id], activeTabId: id } : group));
      return normalize({ tabs, groups, focusedGroupId: prev.focusedGroupId });
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setState((prev) => {
      const ownerIndex = prev.groups.findIndex((group) => group.tabIds.includes(tabId));
      if (ownerIndex === -1) return prev;

      const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
      const groups = prev.groups.map((group, index) => {
        if (index !== ownerIndex) return group;
        const tabIds = group.tabIds.filter((id) => id !== tabId);
        const activeTabId = group.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : group.activeTabId;
        return { ...group, tabIds, activeTabId };
      });

      // Focus only actually needs to move if the group that just emptied out
      // was the focused one — closing a background tab in a group you're not
      // even looking at shouldn't steal focus.
      const ownerEmptied = groups[ownerIndex].tabIds.length === 0 && groups.length > 1;
      let focusedGroupId = prev.focusedGroupId;
      if (ownerEmptied && prev.focusedGroupId === groups[ownerIndex].id) {
        const neighborIndex = ownerIndex > 0 ? ownerIndex - 1 : ownerIndex + 1;
        focusedGroupId = groups[neighborIndex]?.id ?? focusedGroupId;
      }

      return normalize({ tabs, groups, focusedGroupId });
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    // Clicking the tab that is already active in the already-focused group —
    // the most common click in the app, and one that would otherwise rebuild
    // the whole state object (a guaranteed re-render of `App`) plus rewrite
    // all three persistence keys, to end up at exactly the state it started
    // from. Same reasoning as `focusGroup`'s guard below.
    const current = stateRef.current;
    const focused = current.groups.find((group) => group.id === current.focusedGroupId);
    if (focused?.activeTabId === tabId) return;

    setState((prev) => {
      const owner = findGroupOfTab(prev.groups, tabId);
      if (!owner) return prev;
      return {
        ...prev,
        groups: prev.groups.map((group) => (group.id === owner.id ? { ...group, activeTabId: tabId } : group)),
        focusedGroupId: owner.id,
      };
    });
  }, []);

  const focusGroup = useCallback((groupId: string) => {
    // "Focus follows the pointer" calls this on every single pointerdown
    // inside a group (TabGroupLayout's `onPointerDownCapture`), so the call
    // that changes nothing is by far the common one — including the
    // pointerdown that merely starts a text selection in the log.
    //
    // Returning `prev` from the updater is NOT enough to make that free.
    // React's "same value bails out" only skips the render when it can
    // resolve the update eagerly, which it can't once the component has
    // other work pending — and `App` almost always does. Measured (a
    // Profiler around `<App />`, counting commits): one pointerdown inside a
    // panel committed a full render of the app, every mounted conversation
    // included, while the same pointerdown outside any panel committed
    // none. Answering here, before `setState`, is what actually costs
    // nothing.
    if (stateRef.current.focusedGroupId === groupId) return;
    setState((prev) => (prev.groups.some((group) => group.id === groupId) ? { ...prev, focusedGroupId: groupId } : prev));
  }, []);

  /** Reorders within a group, or moves a tab from its current group into
   * another at a given index — replaces the old single-group `reorderTabs`.
   * The destination group becomes focused either way, matching "drag follows
   * the pointer". */
  const moveTab = useCallback((tabId: string, groupId: string, index: number) => {
    setState((prev) => {
      const sourceGroup = findGroupOfTab(prev.groups, tabId);
      if (!sourceGroup || !prev.groups.some((group) => group.id === groupId)) return prev;

      const groups = prev.groups.map((group) => {
        if (group.id === sourceGroup.id && group.id === groupId) {
          const withoutTab = group.tabIds.filter((id) => id !== tabId);
          const clampedIndex = Math.max(0, Math.min(index, withoutTab.length));
          return { ...group, tabIds: [...withoutTab.slice(0, clampedIndex), tabId, ...withoutTab.slice(clampedIndex)] };
        }
        if (group.id === sourceGroup.id) {
          const tabIds = group.tabIds.filter((id) => id !== tabId);
          return { ...group, tabIds, activeTabId: group.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : group.activeTabId };
        }
        if (group.id === groupId) {
          const clampedIndex = Math.max(0, Math.min(index, group.tabIds.length));
          return { ...group, tabIds: [...group.tabIds.slice(0, clampedIndex), tabId, ...group.tabIds.slice(clampedIndex)], activeTabId: tabId };
        }
        return group;
      });

      return normalize({ ...prev, groups, focusedGroupId: groupId });
    });
  }, []);

  /** Moves a tab into a brand-new group inserted right after `afterGroupId`
   * (`null` inserts it as the new first group — the left-edge drop zone).
   * No-op past `MAX_GROUPS`, or if `tabId` is already alone in its group (the
   * resulting layout would be identical, since a tab can't appear in two
   * groups at once — no mirroring). */
  const splitTabToNewGroup = useCallback((tabId: string, afterGroupId: string | null) => {
    setState((prev) => {
      if (prev.groups.length >= MAX_GROUPS) return prev;
      const sourceGroup = findGroupOfTab(prev.groups, tabId);
      if (!sourceGroup || sourceGroup.tabIds.length === 1) return prev;
      const afterIndex = afterGroupId === null ? -1 : prev.groups.findIndex((group) => group.id === afterGroupId);
      if (afterGroupId !== null && afterIndex === -1) return prev;

      // Existing groups give up NEW_GROUP_SIZE between them, proportionally
      // to their current share, so the new group lands at exactly the size
      // its drop-zone tint promised instead of an even split of the total.
      const newGroup = createGroup([tabId], tabId, NEW_GROUP_SIZE);
      const existingScale = 1 - NEW_GROUP_SIZE;
      const groups = prev.groups.map((group) => {
        const scaled = { ...group, size: group.size * existingScale };
        if (group.id !== sourceGroup.id) return scaled;
        const tabIds = group.tabIds.filter((id) => id !== tabId);
        return { ...scaled, tabIds, activeTabId: scaled.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : scaled.activeTabId };
      });
      groups.splice(afterIndex + 1, 0, newGroup);

      return normalize({ tabs: prev.tabs, groups, focusedGroupId: newGroup.id });
    });
  }, []);

  /** One fraction per current group, left to right — from the resize drag,
   * called once on pointer up (see `useGroupSizeDrag`), not per frame. */
  const setGroupSizes = useCallback((sizes: number[]) => {
    setState((prev) => {
      if (sizes.length !== prev.groups.length) return prev;
      return normalize({ ...prev, groups: prev.groups.map((group, index) => ({ ...group, size: sizes[index] })) });
    });
  }, []);

  /** The three per-tab flags below share a shape: they are written on every
   * edge of something that mostly does not change (the badge is cleared on
   * every tab switch whether or not it was set; a turn's state and its
   * background jobs are re-asserted from the socket), so the write that
   * changes nothing is the common one. Each answers that before touching
   * `setState` — the updater's `return prev` alone still costs a render of
   * `App`, and `App` is the whole app. Same guard as `focusGroup`. */
  const setTabFlag = useCallback(
    <K extends "hasUnreadCompletion" | "isRunning" | "hasBackgroundJob">(tabId: string, key: K, value: boolean) => {
      const current = stateRef.current.tabs.find((tab) => tab.id === tabId);
      if (!current || current[key] === value) return;
      setState((prev) => {
        const tab = prev.tabs.find((t) => t.id === tabId);
        if (!tab || tab[key] === value) return prev;
        return { ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, [key]: value } : t)) };
      });
    },
    [],
  );

  const setUnread = useCallback(
    (tabId: string, value: boolean) => setTabFlag(tabId, "hasUnreadCompletion", value),
    [setTabFlag],
  );

  const setRunning = useCallback((tabId: string, value: boolean) => setTabFlag(tabId, "isRunning", value), [setTabFlag]);

  const setHasBackgroundJob = useCallback(
    (tabId: string, value: boolean) => setTabFlag(tabId, "hasBackgroundJob", value),
    [setTabFlag],
  );

  /** Called when a session's title comes into existence or changes — either
   * from automatic inference of the first prompt (ChatPanel, live via
   * WS) or from a manual rename done in the sidebar. No-op if the session isn't
   * open as a tab right now (e.g. rename of a closed session) — the
   * same bailout as `setUnread`/`setRunning` above. */
  const setTabTitle = useCallback((tabId: string, title: string) => {
    const current = stateRef.current.tabs.find((tab) => tab.id === tabId);
    if (!current || current.title === title) return;
    setState((prev) => {
      const tab = prev.tabs.find((t) => t.id === tabId);
      if (!tab || tab.title === title) return prev;
      return { ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) };
    });
  }, []);

  const getPersistedTabs = useCallback((): PersistedTabs | null => {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw === null) return migrateLegacyTabs();
    try {
      const parsed: unknown = JSON.parse(raw);
      const tabs = parsed as PersistedTab[];
      if (tabs.length === 0) return null;
      const activeTabId = localStorage.getItem(ACTIVE_TAB_KEY);
      return { tabs, activeTabId: activeTabId && tabs.some((t) => t.id === activeTabId) ? activeTabId : null };
    } catch {
      return null;
    }
  }, []);

  const restoreTabs = useCallback((persistedTabs: PersistedTab[], activeTabId: string | null) => {
    hydratedRef.current = true;
    setState(() => {
      const tabs: Tab[] = persistedTabs.map((persisted) => ({
        id: persisted.id,
        profileId: persisted.profileId,
        title: persisted.title,
        hasUnreadCompletion: false,
        isRunning: false,
        hasBackgroundJob: false,
        isNew: false,
      }));
      const layout = getPersistedLayout(persistedTabs, activeTabId ?? tabs[tabs.length - 1]?.id ?? null);
      return normalize({ tabs, groups: layout.groups, focusedGroupId: layout.focusedGroupId });
    });
  }, []);

  const focusedGroup = state.groups.find((group) => group.id === state.focusedGroupId);
  const activeTabId = focusedGroup?.activeTabId ?? null;
  const visibleTabIds = useMemo(
    () => new Set(state.groups.map((group) => group.activeTabId).filter((id): id is string => id !== null)),
    [state.groups],
  );

  return {
    tabs: state.tabs,
    groups: state.groups,
    focusedGroupId: state.focusedGroupId,
    activeTabId,
    visibleTabIds,
    openTab,
    closeTab,
    setActiveTab,
    focusGroup,
    moveTab,
    splitTabToNewGroup,
    setGroupSizes,
    setUnread,
    setRunning,
    setHasBackgroundJob,
    setTabTitle,
    getPersistedTabs,
    restoreTabs,
  };
}
