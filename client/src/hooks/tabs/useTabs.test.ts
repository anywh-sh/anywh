import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_GROUPS, useTabs } from "@/hooks/tabs/useTabs";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useTabs — groups", () => {
  it("starts as a single, empty group", () => {
    const { result } = renderHook(() => useTabs());
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual([]);
    expect(result.current.focusedGroupId).toBe(result.current.groups[0].id);
    expect(result.current.activeTabId).toBeNull();
  });

  it("opens a new tab into the focused group and activates it there", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.openTab("p1", "s1"));
    expect(result.current.tabs.map((t) => t.id)).toEqual(["s1"]);
    expect(result.current.groups[0].tabIds).toEqual(["s1"]);
    expect(result.current.activeTabId).toBe("s1");
  });

  it("opening a tab that's already open elsewhere focuses its group instead of duplicating it", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;
    expect(groupA.tabIds).toEqual(["s1"]);
    expect(groupB.tabIds).toEqual(["s2"]);

    // Focus back on group A, then "open" s2 again — should jump focus to
    // group B and activate it there, never create a third copy.
    act(() => result.current.focusGroup(groupA.id));
    act(() => result.current.openTab("p1", "s2"));

    expect(result.current.tabs.filter((t) => t.id === "s2")).toHaveLength(1);
    expect(result.current.focusedGroupId).toBe(groupB.id);
    expect(result.current.groups.find((g) => g.id === groupB.id)?.activeTabId).toBe("s2");
  });

  it("closing the last tab of a group removes the group and redistributes its size", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    expect(result.current.groups).toHaveLength(2);

    act(() => result.current.closeTab("s2"));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].size).toBeCloseTo(1);
    expect(result.current.tabs.map((t) => t.id)).toEqual(["s1"]);
  });

  it("closing the last tab of the only group leaves one empty group, never zero", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.openTab("p1", "s1"));
    act(() => result.current.closeTab("s1"));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it("moves focus to the left neighbor when the focused group collapses", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
      result.current.openTab("p1", "s3");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    act(() => result.current.splitTabToNewGroup("s3", result.current.groups[1].id));
    const [groupA, groupB, groupC] = result.current.groups;
    expect([groupA.tabIds, groupB.tabIds, groupC.tabIds]).toEqual([["s1"], ["s2"], ["s3"]]);

    act(() => result.current.focusGroup(groupB.id));
    act(() => result.current.closeTab("s2"));

    expect(result.current.groups.map((g) => g.tabIds)).toEqual([["s1"], ["s3"]]);
    expect(result.current.focusedGroupId).toBe(groupA.id);
  });

  it("moves focus to the right neighbor when the collapsing group was the first one", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;

    act(() => result.current.focusGroup(groupA.id));
    act(() => result.current.closeTab("s1"));

    expect(result.current.groups.map((g) => g.tabIds)).toEqual([["s2"]]);
    expect(result.current.focusedGroupId).toBe(groupB.id);
  });

  it("closing the last tab of a group that isn't focused leaves focus where it was", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;
    act(() => result.current.focusGroup(groupA.id));

    act(() => result.current.closeTab("s2"));

    expect(result.current.groups.map((g) => g.tabIds)).toEqual([["s1"]]);
    expect(result.current.focusedGroupId).toBe(groupA.id);
    expect(groupB.id).not.toBe(groupA.id); // sanity: they really were different groups
  });

  it("reorders tabs within the same group", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
      result.current.openTab("p1", "s3");
    });
    const groupId = result.current.groups[0].id;

    // Same splice-based semantics as `arrayMove` (dnd-kit): the target index
    // is read against the *original* array, then applied after the dragged
    // item is already removed — dropping s1 "onto" s3's original slot lands
    // it past s3, not before it.
    act(() => result.current.moveTab("s1", groupId, result.current.groups[0].tabIds.indexOf("s3")));

    expect(result.current.groups[0].tabIds).toEqual(["s2", "s3", "s1"]);
  });

  it("moves a tab into another group and focuses the destination", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
      result.current.openTab("p1", "s3");
    });
    act(() => result.current.splitTabToNewGroup("s3", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;
    act(() => result.current.focusGroup(groupA.id));

    act(() => result.current.moveTab("s1", groupB.id, 0));

    expect(result.current.groups.find((g) => g.id === groupA.id)?.tabIds).toEqual(["s2"]);
    expect(result.current.groups.find((g) => g.id === groupB.id)?.tabIds).toEqual(["s1", "s3"]);
    expect(result.current.focusedGroupId).toBe(groupB.id);
  });

  it("collapses the source group when its only tab is dragged out, at the drop rather than mid-drag", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;

    act(() => result.current.moveTab("s2", groupA.id, 0));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual(["s2", "s1"]);
    expect(result.current.groups[0].size).toBeCloseTo(1);
    expect(groupB.id).not.toBe(groupA.id); // sanity: they really were different groups
  });

  it("does not split a group's only tab — the layout would be identical since there's no mirroring", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.openTab("p1", "s1"));
    const groupId = result.current.groups[0].id;

    act(() => result.current.splitTabToNewGroup("s1", groupId));

    expect(result.current.groups).toHaveLength(1);
  });

  it("refuses to create a group past MAX_GROUPS", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      for (let i = 1; i <= MAX_GROUPS + 1; i++) result.current.openTab("p1", `s${i}`);
    });
    for (let i = 1; i < MAX_GROUPS; i++) {
      act(() => result.current.splitTabToNewGroup(`s${i + 1}`, result.current.groups[i - 1].id));
    }
    expect(result.current.groups).toHaveLength(MAX_GROUPS);

    const lastGroupId = result.current.groups[result.current.groups.length - 1].id;
    act(() => result.current.splitTabToNewGroup(`s${MAX_GROUPS + 1}`, lastGroupId));

    expect(result.current.groups).toHaveLength(MAX_GROUPS);
  });

  it("normalizes group sizes from a resize drag to sum to 1", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));

    act(() => result.current.setGroupSizes([0.3, 0.7]));
    const sizes = result.current.groups.map((g) => g.size);
    expect(sizes[0]).toBeCloseTo(0.3);
    expect(sizes[1]).toBeCloseTo(0.7);
    expect(sizes[0] + sizes[1]).toBeCloseTo(1);
  });

  it("ignores setGroupSizes when the number of sizes doesn't match the number of groups", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.openTab("p1", "s1"));
    const before = result.current.groups;

    act(() => result.current.setGroupSizes([0.3, 0.7]));

    expect(result.current.groups).toBe(before);
  });
});

describe("useTabs — persistence and migration", () => {
  it("falls back to a single group in persisted order when no layout blob exists", () => {
    localStorage.setItem(
      "anywh:tabs",
      JSON.stringify([
        { id: "s1", profileId: "p1", title: "One" },
        { id: "s2", profileId: "p1", title: "Two" },
      ]),
    );
    localStorage.setItem("anywh:active-tab", "s2");

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs();
    expect(persisted).not.toBeNull();
    act(() => result.current.restoreTabs(persisted!.tabs, persisted!.activeTabId));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual(["s1", "s2"]);
    expect(result.current.activeTabId).toBe("s2");
  });

  it("falls back to a single group when the layout blob is corrupted JSON", () => {
    localStorage.setItem("anywh:tabs", JSON.stringify([{ id: "s1", profileId: "p1", title: null }]));
    localStorage.setItem("anywh:tab-layout", "{not json");

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs()!;
    act(() => result.current.restoreTabs(persisted.tabs, persisted.activeTabId));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual(["s1"]);
  });

  it("falls back to a single group when the layout blob predates versioning", () => {
    localStorage.setItem("anywh:tabs", JSON.stringify([{ id: "s1", profileId: "p1", title: null }]));
    localStorage.setItem("anywh:tab-layout", JSON.stringify({ groups: [{ id: "g1", tabIds: ["s1"], activeTabId: "s1", size: 1 }] }));

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs()!;
    act(() => result.current.restoreTabs(persisted.tabs, persisted.activeTabId));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual(["s1"]);
  });

  it("drops a tabId that's no longer in the pool and renormalizes what's left", () => {
    localStorage.setItem(
      "anywh:tabs",
      JSON.stringify([
        { id: "s1", profileId: "p1", title: null },
        { id: "s2", profileId: "p1", title: null },
      ]),
    );
    localStorage.setItem(
      "anywh:tab-layout",
      JSON.stringify({
        version: 1,
        groups: [
          { id: "g1", tabIds: ["s1", "ghost"], activeTabId: "ghost", size: 0.5 },
          { id: "g2", tabIds: ["s2"], activeTabId: "s2", size: 0.5 },
        ],
        focusedGroupId: "g1",
      }),
    );

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs()!;
    act(() => result.current.restoreTabs(persisted.tabs, persisted.activeTabId));

    expect(result.current.groups).toHaveLength(2);
    expect(result.current.groups[0].tabIds).toEqual(["s1"]);
    expect(result.current.groups[0].activeTabId).toBe("s1");
    const total = result.current.groups.reduce((sum, g) => sum + g.size, 0);
    expect(total).toBeCloseTo(1);
  });

  it("drops a group left with no real tabs and falls back if that empties the whole layout", () => {
    localStorage.setItem("anywh:tabs", JSON.stringify([{ id: "s1", profileId: "p1", title: null }]));
    localStorage.setItem(
      "anywh:tab-layout",
      JSON.stringify({
        version: 1,
        groups: [{ id: "g1", tabIds: ["ghost-only"], activeTabId: "ghost-only", size: 1 }],
        focusedGroupId: "g1",
      }),
    );

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs()!;
    act(() => result.current.restoreTabs(persisted.tabs, persisted.activeTabId));

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].tabIds).toEqual(["s1"]);
  });

  it("points focusedGroupId at the first group when the persisted one no longer exists", () => {
    localStorage.setItem(
      "anywh:tabs",
      JSON.stringify([
        { id: "s1", profileId: "p1", title: null },
        { id: "s2", profileId: "p1", title: null },
      ]),
    );
    localStorage.setItem(
      "anywh:tab-layout",
      JSON.stringify({
        version: 1,
        groups: [
          { id: "g1", tabIds: ["s1"], activeTabId: "s1", size: 0.5 },
          { id: "g2", tabIds: ["s2"], activeTabId: "s2", size: 0.5 },
        ],
        focusedGroupId: "does-not-exist",
      }),
    );

    const { result } = renderHook(() => useTabs());
    const persisted = result.current.getPersistedTabs()!;
    act(() => result.current.restoreTabs(persisted.tabs, persisted.activeTabId));

    expect(result.current.focusedGroupId).toBe(result.current.groups[0].id);
  });
});

/** These guard the render cost of the two calls the UI makes most often, not
 * a visible behavior — both were already no-ops state-wise before the guards
 * existed, and both still re-rendered `App` (and with it every mounted
 * conversation) every time. A render counter is the only way to assert that
 * from here; see the comments on `focusGroup`/`setActiveTab`. */
describe("useTabs — no-op calls cost no render", () => {
  it("focusing the already-focused group does not re-render", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTabs();
    });
    act(() => result.current.openTab("p1", "s1"));

    const before = renders;
    act(() => result.current.focusGroup(result.current.focusedGroupId));

    expect(renders).toBe(before);
  });

  it("activating the already-active tab does not re-render", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTabs();
    });
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });

    const before = renders;
    act(() => result.current.setActiveTab("s2"));

    expect(renders).toBe(before);
    expect(result.current.activeTabId).toBe("s2");
  });

  it("still moves focus when the tab lives in another group", () => {
    const { result } = renderHook(() => useTabs());
    act(() => {
      result.current.openTab("p1", "s1");
      result.current.openTab("p1", "s2");
    });
    act(() => result.current.splitTabToNewGroup("s2", result.current.groups[0].id));
    const [groupA, groupB] = result.current.groups;
    act(() => result.current.focusGroup(groupA.id));

    // `s2` is already its own group's active tab, but that group isn't the
    // focused one — the guard must not swallow this.
    act(() => result.current.setActiveTab("s2"));

    expect(result.current.focusedGroupId).toBe(groupB.id);
    expect(result.current.activeTabId).toBe("s2");
  });
});
