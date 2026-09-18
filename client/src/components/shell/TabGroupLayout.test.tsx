import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabGroupLayout, EDGE_START_DROP_ID, EDGE_END_DROP_ID, resolveTabDrop } from "./TabGroupLayout";
import { groupEndDropId } from "./TabGroupStrip";
import type { Tab, TabGroup } from "@/hooks/tabs/useTabs";

afterEach(() => cleanup());

// happy-dom has no layout engine (`offsetWidth`/`getBoundingClientRect` are
// stubbed in `tests/setup.ts`), so pixel geometry can never be asserted here
// — what actually encodes the design is the `calc()` string itself, over the
// `--g{i}-frac`/`--g{i}-cum` custom properties. These tests pin that formula
// down so a future edit that quietly breaks the strip/panel alignment (or
// reintroduces per-frame React renders during a resize) fails loudly.

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    profileId: "default",
    title: id,
    hasUnreadCompletion: false,
    isRunning: false,
    hasBackgroundJob: false,
    isNew: false,
    ...overrides,
  };
}

function group(id: string, tabIds: string[], size: number): TabGroup {
  return { id, tabIds, activeTabId: tabIds[0] ?? null, size };
}

function renderLayout(
  tabs: Tab[],
  groups: TabGroup[],
  overrides: {
    activeTabId?: string | null;
    splitEnabled?: boolean;
    renderPanel?: (tab: Tab, groupId: string | null) => ReactNode;
  } = {},
) {
  return render(
    <TooltipProvider>
      <TabGroupLayout
        tabs={tabs}
        groups={groups}
        activeTabId={overrides.activeTabId ?? tabs[0]?.id ?? null}
        splitEnabled={overrides.splitEnabled ?? true}
        onSelect={vi.fn()}
        onFocusGroup={vi.fn()}
      onNewTab={vi.fn()}
        onClose={vi.fn()}
        onMoveTab={vi.fn()}
        onSplitTabToNewGroup={vi.fn()}
        onCommitSizes={vi.fn()}
        onRenameSession={vi.fn()}
        onDelete={vi.fn()}
        renderPanel={overrides.renderPanel ?? ((t) => <div>{t.title}</div>)}
      />
    </TooltipProvider>,
  );
}

describe("TabGroupLayout geometry", () => {
  it("fills 100% for a single group", () => {
    const tabs = [tab("s1")];
    renderLayout(tabs, [group("g1", ["s1"], 1)]);

    const panel = screen.getByTestId("tab-panel-s1");
    expect(panel.style.left).toBe("calc(100% * var(--g0-cum, 0) + 0px)");
    expect(panel.style.width).toBe("calc(100% * var(--g0-frac, 1))");
  });

  it("splits the available width (minus handles) proportionally across two groups", () => {
    const tabs = [tab("s1"), tab("s2")];
    renderLayout(tabs, [group("g1", ["s1"], 0.3), group("g2", ["s2"], 0.7)]);

    const panelA = screen.getByTestId("tab-panel-s1");
    const panelB = screen.getByTestId("tab-panel-s2");
    const avail = "calc(100% - 4px)";

    expect(panelA.style.left).toBe(`calc(${avail} * var(--g0-cum, 0) + 0px)`);
    expect(panelA.style.width).toBe(`calc(${avail} * var(--g0-frac, 0.3))`);
    expect(panelB.style.left).toBe(`calc(${avail} * var(--g1-cum, 0) + 4px)`);
    expect(panelB.style.width).toBe(`calc(${avail} * var(--g1-frac, 0.7))`);
  });

  it("accounts for both handles across three groups", () => {
    const tabs = [tab("s1"), tab("s2"), tab("s3")];
    renderLayout(tabs, [group("g1", ["s1"], 0.2), group("g2", ["s2"], 0.3), group("g3", ["s3"], 0.5)]);

    const avail = "calc(100% - 8px)";
    expect(screen.getByTestId("tab-panel-s1").style.left).toBe(`calc(${avail} * var(--g0-cum, 0) + 0px)`);
    expect(screen.getByTestId("tab-panel-s2").style.left).toBe(`calc(${avail} * var(--g1-cum, 0) + 4px)`);
    expect(screen.getByTestId("tab-panel-s3").style.left).toBe(`calc(${avail} * var(--g2-cum, 0) + 8px)`);
  });

  it("gives the strip row the exact same calc() expression as its group's panel, in flexBasis", () => {
    const tabs = [tab("s1"), tab("s2")];
    const groups = [group("g1", ["s1"], 0.4), group("g2", ["s2"], 0.6)];
    renderLayout(tabs, groups);

    for (const [index, g] of groups.entries()) {
      const strip = screen.getByTestId(`group-strip-${g.id}`);
      const panel = screen.getByTestId(`tab-panel-${g.tabIds[0]}`);
      expect(strip.style.flexBasis).toContain(`var(--g${index}-frac`);
      expect(panel.style.width).toContain(`var(--g${index}-frac`);
      // Same avail expression on both, not just the same variable name.
      const availFromStrip = strip.style.flexBasis.split(" * ")[0];
      const availFromPanel = panel.style.width.split(" * ")[0];
      expect(availFromStrip).toBe(availFromPanel);
    }
  });

  it("hides every tab except its group's active one, without ever unmounting it", () => {
    const tabs = [tab("s1"), tab("s2")];
    renderLayout(tabs, [group("g1", ["s1", "s2"], 1)]);

    expect(screen.getByTestId("tab-panel-s1")).not.toHaveClass("invisible");
    const hiddenPanel = screen.getByTestId("tab-panel-s2");
    expect(hiddenPanel).toHaveClass("invisible");
    // Still in the DOM, not removed — that's the whole point of the flat layer.
    expect(hiddenPanel).toBeInTheDocument();
  });
});

describe("TabGroupLayout — compact fallback (splitEnabled: false)", () => {
  it("flattens every group's tabs into a single strip instead of one per group", () => {
    const tabs = [tab("s1"), tab("s2"), tab("s3")];
    const groups = [group("g1", ["s1", "s2"], 0.5), group("g2", ["s3"], 0.5)];
    renderLayout(tabs, groups, { activeTabId: "s1", splitEnabled: false });

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual(["s1", "s2", "s3"]);
  });

  it("shows only the overall active tab's panel, full width", () => {
    const tabs = [tab("s1"), tab("s2")];
    const groups = [group("g1", ["s1"], 0.5), group("g2", ["s2"], 0.5)];
    renderLayout(tabs, groups, { activeTabId: "s2", splitEnabled: false });

    expect(screen.getByTestId("tab-panel-s1")).toHaveClass("invisible");
    const visiblePanel = screen.getByTestId("tab-panel-s2");
    expect(visiblePanel).not.toHaveClass("invisible");
    expect(visiblePanel).toHaveClass("inset-0");
  });

  it("never drops a tab out of the DOM — both groups' tabs stay mounted", () => {
    const tabs = [tab("s1"), tab("s2"), tab("s3")];
    const groups = [group("g1", ["s1", "s2"], 0.5), group("g2", ["s3"], 0.5)];
    renderLayout(tabs, groups, { activeTabId: "s1", splitEnabled: false });

    expect(screen.getByTestId("tab-panel-s1")).toBeInTheDocument();
    expect(screen.getByTestId("tab-panel-s2")).toBeInTheDocument();
    expect(screen.getByTestId("tab-panel-s3")).toBeInTheDocument();
  });
});

// `renderPanel`'s second argument is how a tab's `ChatPanel` learns which
// group's `TabGroupStrip` toggle slot to portal into (panelTogglesSlot.ts) —
// `cwd` (what actually gates those buttons) is deliberately not lifted up
// here, so this is the one piece of that wiring `TabGroupLayout` itself
// still owns and that's worth pinning down.
describe("TabGroupLayout — renderPanel's groupId argument", () => {
  it("passes each tab's own group id in split mode", () => {
    const tabs = [tab("s1"), tab("s2")];
    const groups = [group("g1", ["s1"], 0.5), group("g2", ["s2"], 0.5)];
    const renderPanel = vi.fn((t: Tab) => <div>{t.title}</div>);
    renderLayout(tabs, groups, { renderPanel });

    expect(renderPanel).toHaveBeenCalledWith(tabs[0], "g1");
    expect(renderPanel).toHaveBeenCalledWith(tabs[1], "g2");
  });

  it("passes null in flat/compact mode — no per-group strip exists there to own a slot", () => {
    const tabs = [tab("s1"), tab("s2")];
    const groups = [group("g1", ["s1"], 0.5), group("g2", ["s2"], 0.5)];
    const renderPanel = vi.fn((t: Tab) => <div>{t.title}</div>);
    renderLayout(tabs, groups, { splitEnabled: false, renderPanel });

    expect(renderPanel).toHaveBeenCalledWith(tabs[0], null);
    expect(renderPanel).toHaveBeenCalledWith(tabs[1], null);
  });
});

// Dragging a tab between groups can't be exercised by simulating a real
// dnd-kit pointer gesture in happy-dom (its collision detection depends on
// element rects, and happy-dom has no layout engine — see the stubbed
// `getBoundingClientRect` in tests/setup.ts). `resolveTabDrop` is the pure
// function `onDragEnd` defers to for "what should this drop do", pulled out
// specifically so it's testable on its own merits: given a tab id, an
// `over.id`, and the current groups, what should happen.
describe("resolveTabDrop", () => {
  const groups = [group("g1", ["s1", "s2"], 0.5), group("g2", ["s3"], 0.5)];

  it("drops on itself → no-op", () => {
    expect(resolveTabDrop("s1", "s1", groups)).toBeNull();
  });

  it("drops on another tab in the same group → reorder within it", () => {
    expect(resolveTabDrop("s1", "s2", groups)).toEqual({ type: "move", groupId: "g1", index: 1 });
  });

  it("drops on a tab in a different group → move into that group, at its index", () => {
    expect(resolveTabDrop("s1", "s3", groups)).toEqual({ type: "move", groupId: "g2", index: 0 });
  });

  it("drops on a group's trailing drop zone → move to the end of that group", () => {
    expect(resolveTabDrop("s3", groupEndDropId("g1"), groups)).toEqual({ type: "move", groupId: "g1", index: 2 });
  });

  it("drops on the left edge zone → split into a new first group", () => {
    expect(resolveTabDrop("s1", EDGE_START_DROP_ID, groups)).toEqual({ type: "split-start" });
  });

  it("drops on the right edge zone → split into a new last group", () => {
    expect(resolveTabDrop("s1", EDGE_END_DROP_ID, groups)).toEqual({ type: "split-end" });
  });

  it("drops on an id that matches nothing (stale over) → no-op", () => {
    expect(resolveTabDrop("s1", "does-not-exist", groups)).toBeNull();
  });
});
