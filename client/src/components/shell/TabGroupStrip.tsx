import { useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDict } from "@/i18n";
import { cn, scrollHorizontallyOnWheel, truncateWords } from "@/lib/utils";
import type { Tab } from "@/hooks/tabs/useTabs";
import { profileCloseHoverClass, profileColorClass, profileTabClasses } from "@/lib/profiles/profiles";
import { useContextMenu } from "@/hooks/platform/useContextMenu";
import { SessionDeleteMenu } from "@/components/shell/SessionDeleteMenu";
import { RenameSessionDialog } from "@/components/shell/RenameSessionDialog";
import { setPanelTogglesSlot } from "@/lib/panelTogglesSlot";

// A long enough session title (auto-inferred from the first prompt, or
// hand-typed via rename) could otherwise stretch the tooltip arbitrarily
// wide — this caps it to roughly a glance's worth of text, kept on the one
// line TooltipContent below forces with `whitespace-nowrap`.
const MAX_TOOLTIP_TITLE_WORDS = 12;

/** Id of a group's trailing drop zone — matched against `over.id` by
 * `TabGroupLayout`'s single `onDragEnd` to mean "append at the end of this
 * group" (also the only drop target an empty group has, since it has no
 * tabs of its own to drop onto). */
export function groupEndDropId(groupId: string): string {
  return `group-end-${groupId}`;
}

interface TabGroupStripProps {
  groupId: string;
  tabs: Tab[];
  activeTabId: string | null;
  /** Split is desktop-only (same gate as the dock) — below the compact
   * breakpoint there's nowhere to put a second column, so the "Mover para
   * novo grupo" context-menu item (the third of the three ways to split,
   * alongside the edge drag and `Ctrl+\`) stays hidden regardless of how
   * many tabs are in the group. */
  allowSplit: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onRenameSession: (tabId: string, title: string) => void;
  onDelete: (tabId: string) => void;
  onSplitToNewGroup: (tabId: string) => void;
  /** The `+` at the end of the strip — opens a new conversation in THIS
   * group, which is why it isn't just the sidebar's own handler: `openTab`
   * always appends to the focused group, so the caller has to focus this
   * one first (see `TabGroupLayout`). */
  onNewTab: () => void;
}

interface SortableTabProps {
  tab: Tab;
  isActive: boolean;
  canSplit: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onRename: (tab: Tab) => void;
  onDelete: (tabId: string) => void;
  onSplitToNewGroup: (tabId: string) => void;
  buttonRef: (id: string, el: HTMLButtonElement | null) => void;
}

// Was Radix's `TabsTrigger` (`components/ui/tabs.tsx`) before a group could
// have more than one strip alive at once — Radix's `Tabs` root only supports
// a single active `value` shared by every descendant, which stopped working
// the moment two groups each needed their own independently-active tab. What
// stood here was the exact resolved class string of Radix's "line" variant,
// carried over verbatim so nothing broke in the swap; the redesign is where
// that debt gets paid, since the tab is being restyled anyway. It still sets
// `data-state`/`aria-selected` itself instead of delegating to Radix, which
// is what keeps `profileTabClasses`'s `data-[state=active]:bg-*` working.
//
// No hover background on the tab itself — only its close button gets one
// (see the button below). Hovering a tab still changes its text color, just
// not its fill.
const TAB_TRIGGER_CLASS =
  "relative z-10 inline-flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-r border-border-soft py-1 pr-7 pl-3 font-mono text-xs whitespace-nowrap text-text-faint transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none data-[state=active]:text-foreground";

/**
 * Only spreads dnd-kit's `listeners`/`setNodeRef`, not `attributes` — avoids
 * generic `role`/`tabIndex` colliding with the `role="tab"` the inner button
 * sets itself. No `KeyboardSensor` on the `DndContext` for the same reason:
 * ArrowLeft/Right already moves focus between tabs (roving focus, see
 * `TabGroupStrip`'s `handleTabListKeyDown`), would collide with "move
 * dragged item".
 */
function SortableTab({ tab, isActive, canSplit, onSelect, onClose, onRename, onDelete, onSplitToNewGroup, buttonRef }: SortableTabProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: tab.id });
  const menu = useContextMenu();
  const dict = useDict();
  const title = tab.title ?? dict.common.untitledSession;

  return (
    <Tooltip>
      {/* Wraps the whole row (not just the tab button) for two reasons: (1)
          this plain `div` has no `data-state` of its own, so the tooltip's
          `asChild` prop merge landing on it can't clobber anything — an
          earlier attempt wrapped the tab button directly, which merged the
          tooltip's own open/closed `data-state` on top of the tab's own
          active/inactive one, silently breaking both the profile tint and
          the border override that key off it. (2) unlike a `display:contents`
          wrapper (tried first, to dodge exactly that collision), this `div`
          has a real box — Radix Popper positions the tooltip off the
          trigger's `getBoundingClientRect()`, which is empty for a `contents`
          element, so it anchored at the viewport's top-left instead of under
          the tab. */}
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          onContextMenu={menu.onContextMenu}
          // Chrome-style middle-click-to-close, anywhere on the tab (not just
          // the X). `onMouseDown` (not `onClick`, which never fires for the
          // middle button) prevents the browser's autoscroll-mode cursor —
          // that starts on mousedown, so `onAuxClick` alone would still flash it.
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button === 1) onClose(tab.id);
          }}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            opacity: isDragging ? 0.5 : 1,
            zIndex: isDragging ? 1 : undefined,
          }}
          className="group relative flex min-w-[72px] flex-[0_1_168px] items-center"
        >
          <button
            ref={(el) => buttonRef(tab.id, el)}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-state={isActive ? "active" : "inactive"}
            data-tab-id={tab.id}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={cn(TAB_TRIGGER_CLASS, profileTabClasses(tab.profileId))}
          >
            {tab.isRunning ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-foreground" aria-label={dict.chat.tabs.agentWorking} />
            ) : (
              tab.hasUnreadCompletion && (
                // The "turn finished, unseen" dot takes the profile's own
                // colour. This deliberately reverses an earlier call: the
                // dot used to be `--status-done`, a blue chosen precisely so
                // it would NOT be read as a profile colour. In a tab the
                // ambiguity never materialised — the tab already carries its
                // profile tint, so a dot in that same colour reads as "this
                // session", not as a second, competing signal. That token
                // had no other consumer and goes away with this.
                <span className={cn("size-1.5 shrink-0 rounded-full", profileColorClass(tab.profileId))} aria-label={dict.chat.tabs.sessionDone} />
              )
            )}
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
            aria-label={dict.chat.tabs.close.replace("{title}", title)}
            className={cn(
              // `z-20`: the tab button sits at `z-10` and, being `position:
              // relative`, paints above this sibling `button` otherwise —
              // its clickable box covers the full row including the `pr-7`
              // padding reserved for this button, so without a higher
              // z-index the trigger intercepts every click meant for the X.
              "absolute right-1.5 z-20 cursor-pointer p-0.5 opacity-45 transition-colors",
              "hover:opacity-100",
              profileCloseHoverClass(tab.profileId),
            )}
          >
            <X className="size-3" />
          </button>
          <SessionDeleteMenu
            menu={menu}
            title={title}
            onRename={() => onRename(tab)}
            onDelete={() => onDelete(tab.id)}
            onMoveToNewGroup={canSplit ? () => onSplitToNewGroup(tab.id) : undefined}
          />
        </div>
      </TooltipTrigger>
      {/* `whitespace-nowrap` overrides TooltipContent's own `text-balance`
          (which wraps to balance line lengths) — with the word cap above,
          there's no need to wrap at all, and wrapping read as a bug here. */}
      <TooltipContent side="bottom" className="whitespace-nowrap">
        {truncateWords(title, MAX_TOOLTIP_TITLE_WORDS)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One group's tab strip — extracted out of `TabBar` (now `TabGroupLayout`'s
 * per-group piece) so a multi-group layout can mount one of these per
 * column without duplicating the drag/rename/context-menu wiring. Self-
 * contained: no Radix `Tabs` ancestor needed (each strip owns its own
 * active-tab state via `activeTabId`/`onSelect`), which is exactly what lets
 * more than one of these be mounted at once with independently active tabs.
 *
 * No `DndContext`/sensors of its own — `TabGroupLayout` owns a single one
 * covering every group, which is what makes dragging a tab *between* groups
 * possible at all. This only contributes its `SortableContext` (for
 * same-strip reordering) and the trailing drop zone.
 */
export function TabGroupStrip({
  groupId,
  tabs,
  activeTabId,
  allowSplit,
  onSelect,
  onClose,
  onRenameSession,
  onDelete,
  onSplitToNewGroup,
  onNewTab,
}: TabGroupStripProps) {
  const dict = useDict();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  // Fills whatever width the tabs don't — a separate, non-overlapping
  // droppable rather than wrapping the whole strip, so it never competes
  // with an individual tab's own droppable rect for `over` (dnd-kit doesn't
  // give a nested droppable priority over its overlapping parent).
  const { setNodeRef: setEndDropRef, isOver: isOverEnd } = useDroppable({ id: groupEndDropId(groupId) });

  // Manual roving focus (ArrowLeft/Right) — replaces the Radix `Tabs` root's
  // own `RovingFocusGroup`, which went away along with it. "Automatic
  // activation" to match its default: moving focus also selects, exactly
  // like Radix's `activationMode="automatic"` did.
  function handleTabListKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target as HTMLElement;
    const currentId = target.dataset.tabId;
    if (!currentId) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
    if (currentIndex === -1) return;
    const nextIndex = event.key === "ArrowLeft" ? currentIndex - 1 : currentIndex + 1;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onSelect(nextTab.id);
    buttonRefs.current.get(nextTab.id)?.focus();
  }

  return (
    <>
      <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
        {/* The height, the chrome background and the bottom rule live on this
            wrapper rather than on the tablist, so the `+` can sit OUTSIDE the
            horizontal scroller and stay pinned to the right edge instead of
            scrolling away with the tabs. */}
        <div className="flex h-9 w-full items-stretch border-b border-border bg-bg-chrome">
          <div
            role="tablist"
            aria-orientation="horizontal"
            onWheel={scrollHorizontallyOnWheel}
            onKeyDown={handleTabListKeyDown}
            // `overflow-y-hidden` isn't decorative here: per the CSS overflow
            // spec, `overflow-x: auto` with `overflow-y` left at its default
            // `visible` gets that default computed up to `auto` too — so
            // without this, shrinking the window narrow enough for a tab's
            // content to wrap could pop a vertical scrollbar on a strip
            // that's meant to only ever scroll horizontally.
            className="scrollbar-thin flex min-w-0 flex-1 flex-nowrap items-stretch justify-start gap-0 overflow-x-auto overflow-y-hidden p-0 text-muted-foreground"
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                canSplit={allowSplit && tabs.length > 1}
                onSelect={onSelect}
                onClose={onClose}
                onRename={(renamedTab) => setRenaming({ id: renamedTab.id, title: renamedTab.title ?? "" })}
                onDelete={onDelete}
                onSplitToNewGroup={onSplitToNewGroup}
                buttonRef={(id, el) => {
                  if (el) buttonRefs.current.set(id, el);
                  else buttonRefs.current.delete(id);
                }}
              />
            ))}
            <div ref={setEndDropRef} className={cn("h-full min-w-2 flex-1", isOverEnd && "bg-border")} />
          </div>
          {/* Published so this group's own active tab's `ChatPanel` can portal
           * the files/terminal toggle pair in here — see panelTogglesSlot.ts
           * for why this is a portal target rather than props flowing down
           * from a lifted `cwd`. `display: contents` keeps the portaled
           * buttons themselves as the flex items in this row, not this span. */}
          <div ref={(node) => setPanelTogglesSlot(groupId, node)} className="contents" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewTab}
                aria-label={dict.chat.tabs.newTab}
                className="flex w-9 shrink-0 cursor-pointer items-center justify-center border-l border-border-soft text-text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{dict.chat.tabs.newTab}</TooltipContent>
          </Tooltip>
        </div>
      </SortableContext>

      <RenameSessionDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        initialTitle={renaming?.title ?? ""}
        onSave={(title) => {
          if (renaming) onRenameSession(renaming.id, title);
          setRenaming(null);
        }}
      />
    </>
  );
}
