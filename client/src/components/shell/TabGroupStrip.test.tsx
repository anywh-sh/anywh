import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabGroupStrip } from "./TabGroupStrip";
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

function renderStrip(tabs: Tab[], activeTabId: string | null, onNewTab = vi.fn()) {
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
