import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabGroupStrip } from "./TabGroupStrip";
import { getPanelTogglesSlot } from "@/lib/panelTogglesSlot";
import { en } from "@/i18n/en";
import type { Tab } from "@/hooks/tabs/useTabs";

afterEach(() => cleanup());

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "s1",
    profileId: "default",
    title: "Uma sessão com título comprido o bastante pra ser truncado na aba",
    hasUnreadCompletion: false,
    isRunning: false,
    hasBackgroundJob: false,
    isNew: false,
    ...overrides,
  };
}

function renderStrip(tabs: Tab[], activeTabId: string | null, onNewTab = vi.fn(), rightPanel?: { shown: boolean; onToggle: () => void }) {
  return render(
    <TooltipProvider>
      <DndContext>
        <TabGroupStrip
          groupId="g1"
          tabs={tabs}
          activeTabId={activeTabId}
          allowSplit
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onRenameSession={vi.fn()}
          onDelete={vi.fn()}
          onSplitToNewGroup={vi.fn()}
          onNewTab={onNewTab}
          rightPanel={rightPanel}
        />
      </DndContext>
    </TooltipProvider>,
  );
}

describe("TabGroupStrip", () => {
  // Regression: wrapping the tab button in `<TooltipTrigger asChild>` directly
  // used to leak the tooltip's own `data-state` (open/closed) onto it,
  // silently winning over the tab's own active/inactive one — neither the
  // profile-tinted background nor the border override (both keyed off
  // `data-[state=active]`) could ever match — the tab just showed through to
  // the page's neutral background instead of its profile color.
  it("keeps the selected tab's own data-state=active even though it's wrapped in a tooltip", () => {
    const t = tab();
    renderStrip([t], t.id);

    const trigger = screen.getByRole("tab", { name: t.title! });
    expect(trigger).toHaveAttribute("data-state", "active");
  });

  it("does not mark an unselected tab as active", () => {
    const active = tab({ id: "s1", title: "Ativa" });
    const other = tab({ id: "s2", title: "Inativa" });
    renderStrip([active, other], active.id);

    expect(screen.getByRole("tab", { name: "Ativa" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "Inativa" })).toHaveAttribute("data-state", "inactive");
  });

  // jsdom has no layout, so what is checkable here is the contract the CSS
  // rests on: only the selected tab is sticky (pinned to whichever edge of
  // the strip it would scroll past), and the strip's own scrollbar is the
  // hidden-native + overlay pair, never the native one that took the strip's
  // height and clipped the profile rule. The behaviour itself is measured in
  // a real browser.
  it("pins only the selected tab to the strip's edges", () => {
    const active = tab({ id: "s1", title: "Ativa" });
    const other = tab({ id: "s2", title: "Inativa" });
    renderStrip([active, other], active.id);

    const wrapperOf = (name: string) => screen.getByRole("tab", { name }).parentElement;
    expect(wrapperOf("Ativa")).toHaveClass("sticky", "left-0", "right-0");
    expect(wrapperOf("Inativa")).not.toHaveClass("sticky");
  });

  // Regression: an unselected tab's wrapper is no stacking context, so its
  // button (`z-10`) and profile rule (`z-20`) paint at the strip's level.
  // With the pinned tab at `z-10` too, the tabs after it — the ones scrolling
  // under it as the strip moves right — drew over it and their titles showed
  // through the pinned tab's.
  it("stacks the pinned tab above everything an unselected tab paints", () => {
    const active = tab({ id: "s1", title: "Ativa" });
    const other = tab({ id: "s2", title: "Inativa" });
    renderStrip([active, other], active.id);

    expect(screen.getByRole("tab", { name: "Ativa" }).parentElement).toHaveClass("z-30");
    expect(screen.getByRole("tab", { name: "Inativa" }).className).toContain("z-10");
    expect(screen.getByRole("tab", { name: "Inativa" }).parentElement?.querySelector("span[aria-hidden='true']")).toHaveClass("z-20");
  });

  it("scrolls without a native scrollbar, which would take height from the tabs", () => {
    renderStrip([tab()], "s1");

    expect(screen.getByRole("tablist")).toHaveClass("scrollbar-hidden");
    expect(screen.getByRole("tablist")).not.toHaveClass("scrollbar-thin");
  });

  it("draws the profile rule across the whole tab and only clips it on an unselected one", () => {
    const active = tab({ id: "s1", title: "Ativa" });
    const other = tab({ id: "s2", title: "Inativa" });
    renderStrip([active, other], active.id);

    const ruleOf = (name: string) => screen.getByRole("tab", { name }).parentElement?.querySelector("span[aria-hidden='true']");
    expect(ruleOf("Ativa")).toHaveClass("-left-px", "-right-px", "[clip-path:inset(0)]");
    expect(ruleOf("Inativa")).toHaveClass("-left-px", "-right-px", "[clip-path:inset(0_13px)]");
  });

  it("shows the tab's full title in a tooltip on hover", async () => {
    const user = userEvent.setup();
    const t = tab();
    renderStrip([t], t.id);

    await user.hover(screen.getByRole("tab", { name: t.title! }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(t.title!);
  });

  it("truncates a tooltip title past 12 words instead of letting it run arbitrarily long", async () => {
    const user = userEvent.setup();
    const longTitle = "Uma sessão com um título absurdamente comprido que passa longe do limite razoável de doze palavras";
    const t = tab({ title: longTitle });
    renderStrip([t], t.id);

    await user.hover(screen.getByRole("tab"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Uma sessão com um título absurdamente comprido que passa longe do limite...",
    );
    expect(tooltip).not.toHaveTextContent("razoável");
  });

  it("moves focus (and selection) to the next tab on ArrowRight, roving-focus style", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const a = tab({ id: "s1", title: "Primeira" });
    const b = tab({ id: "s2", title: "Segunda" });
    render(
      <TooltipProvider>
        <DndContext>
          <TabGroupStrip
            groupId="g1"
            tabs={[a, b]}
            activeTabId={a.id}
            allowSplit
            onSelect={onSelect}
            onClose={vi.fn()}
            onRenameSession={vi.fn()}
            onDelete={vi.fn()}
            onSplitToNewGroup={vi.fn()}
            onNewTab={vi.fn()}
          />
        </DndContext>
      </TooltipProvider>,
    );

    screen.getByRole("tab", { name: "Primeira" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(onSelect).toHaveBeenCalledWith("s2");
    expect(screen.getByRole("tab", { name: "Segunda" })).toHaveFocus();
  });

  it("opens a new tab from the + at the end of the strip", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    renderStrip([tab()], "s1", onNewTab);

    await user.click(screen.getByRole("button", { name: en.chat.tabs.newTab }));

    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  // The relay only titles a session once the first prompt is sent, so a tab
  // opened by `+` carries `title: null` until then. Every surface that names
  // it has to reach for the same dictionary entry — the fallback used to be
  // a Portuguese literal repeated in four places in this file alone.
  it("names an untitled tab from the dictionary, not from a literal", () => {
    renderStrip([tab({ title: null })], "s1");

    expect(screen.getByRole("tab", { name: en.common.untitledSession })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: en.chat.tabs.close.replace("{title}", en.common.untitledSession) }),
    ).toBeInTheDocument();
  });

  // The actual files/terminal toggle buttons are portaled in here by a tab's
  // own `ChatPanel` (see panelTogglesSlot.ts and ChatPanel.tsx) — `cwd`,
  // which gates them, lives only on that tab's socket and is deliberately
  // not passed down as a prop. What this component owns is publishing (and
  // un-publishing) the slot itself, right before the `+`.
  describe("panel toggles slot", () => {
    it("publishes a node for this group id while mounted, right after the +", () => {
      const { unmount } = renderStrip([tab()], "s1");

      const slot = getPanelTogglesSlot("g1");
      expect(slot).not.toBeNull();
      const newTab = screen.getByRole("button", { name: en.chat.tabs.newTab });
      expect(newTab.compareDocumentPosition(slot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      unmount();
      expect(getPanelTogglesSlot("g1")).toBeNull();
    });
  });

  it("hides the split context-menu item when allowSplit is false", async () => {
    const user = userEvent.setup();
    const a = tab({ id: "s1", title: "Primeira" });
    const b = tab({ id: "s2", title: "Segunda" });
    render(
      <TooltipProvider>
        <DndContext>
          <TabGroupStrip
            groupId="g1"
            tabs={[a, b]}
            activeTabId={a.id}
            allowSplit={false}
            onSelect={vi.fn()}
            onClose={vi.fn()}
            onRenameSession={vi.fn()}
            onDelete={vi.fn()}
            onSplitToNewGroup={vi.fn()}
            onNewTab={vi.fn()}
          />
        </DndContext>
      </TooltipProvider>,
    );

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("tab", { name: "Primeira" }) });

    expect(await screen.findByText(en.shell.sidebar.sessionMenu.delete)).toBeInTheDocument();
    expect(screen.queryByText(en.shell.sidebar.sessionMenu.moveToNewGroup)).not.toBeInTheDocument();
  });
});

describe("TabGroupStrip — the side panel toggle", () => {
  it("has the toggle at the right end, with the slot for the panel's buttons before it", () => {
    renderStrip([tab()], "s1", vi.fn(), { shown: true, onToggle: vi.fn() });
    const toggle = screen.getByRole("button", { name: en.panels.hideRightPanel });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const slot = getPanelTogglesSlot("g1");
    expect(slot).not.toBeNull();
    // Slot first, toggle after it: the toggle is the outermost control.
    expect(slot?.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("calls back when pressed", async () => {
    const onToggle = vi.fn();
    renderStrip([tab()], "s1", vi.fn(), { shown: true, onToggle });
    await userEvent.setup().click(screen.getByRole("button", { name: en.panels.hideRightPanel }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  // Hiding the panel hides the buttons that open its panes: a tab's panel
  // draws them into this slot, and finds none while the panel is hidden.
  it("keeps only the toggle while the panel is not showing — no slot for the panes' buttons", () => {
    renderStrip([tab()], "s1", vi.fn(), { shown: false, onToggle: vi.fn() });
    expect(screen.getByRole("button", { name: en.panels.showRightPanel })).toHaveAttribute("aria-pressed", "false");
    expect(getPanelTogglesSlot("g1")).toBeNull();
  });

  it("draws no toggle where there is no side panel", () => {
    renderStrip([tab()], "s1");
    expect(screen.queryByRole("button", { name: en.panels.hideRightPanel })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.panels.showRightPanel })).not.toBeInTheDocument();
  });
});
