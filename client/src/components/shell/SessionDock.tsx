import { useCallback, useRef, type ReactNode } from "react";
import { RailAddButton } from "@/components/shell/RailAddButton";
import { useDockPresence } from "@/hooks/useDockPresence";
import { useDockFrameCut } from "@/hooks/useDockFrameCut";
import { usePanelDrag } from "@/hooks/tabs/usePanelDrag";
import type { DockPaneKind, DockState } from "@/hooks/tabs/useSessionDock";
import { DEFAULT_DOCK_WIDTH, dockWidthBounds } from "@/hooks/tabs/useSessionDock";
import { useDict } from "@/i18n";
import { setPanelTogglesSlot } from "@/lib/panelTogglesSlot";
import { cn } from "@/lib/utils";

/** How far one arrow key press moves the column's edge. */
const KEY_STEP = 16;

/** The rail's width, which its buttons fill edge to edge, and so does the
 * strip's panel toggle above it. */
export const DOCK_RAIL_WIDTH = 40;

interface SessionDockProps {
  dock: DockState;
  onWidthChange: (width: number) => void;
  /** Fires once, on pointer up, after a width drag — flushes the size to
   * storage instead of writing on every `pointermove`. */
  onDragEnd: () => void;
  /** One entry per possible pane kind — `undefined`/absent for a kind that
   * isn't mounted at all (e.g. files pane not implemented yet, or lazily
   * not mounted). Only kinds present in `dock.panes` are actually rendered. */
  panes: Partial<Record<DockPaneKind, ReactNode>>;
  /** The tab it belongs to is not on screen: the column stays mounted, so what
   * is in it (a room's conversation) keeps its connection, but it takes no
   * part in the shell's frame. */
  background?: boolean;
  /** The tab's group, whose pane buttons the rail is the slot for (see
   * `panelTogglesSlot.ts`). */
  groupId: string | null;
}

/**
 * Right-side dock column — took over the role `TerminalPanelSlot` used to
 * play alone: mounted the whole time the chat tab is active even with the
 * dock closed (`dock.panes.length === 0`), so opening/closing it doesn't
 * remount the pane (and lose its scroll position / virtualizer cache) —
 * closing gives its width back instead of unmounting. Both are animated: the
 * width opens or closes and the content fades in or out (the box's own CSS
 * transitions; `useDockPresence` only says when the closing is over).
 * `TerminalPanelSlot`/`FilesPanelSlot` no longer own the column's width —
 * they just fill 100% of the pane space this component hands them.
 *
 * Also owns the column-level resize handle (left edge, horizontal), which
 * acts on the column as a whole, not on an individual pane, which is why
 * `SessionPanel` has no `onStartDrag`.
 *
 * Down its right edge runs the rail: the buttons that open each of its panes,
 * one under the other, under the strip's panel toggle, then a divider and the
 * button that will add views from other platforms. The rail stays when the panel
 * closes — it is what is left of the column, so the panes are one click away
 * whether the panel is showing or not — and only the panel beside it opens
 * and closes. The buttons are portaled in by whoever owns their state (a
 * conversation's `ChatPanel`, a room's `TabPanel`) through the rail's slot.
 */
export function SessionDock({ dock, onWidthChange, onDragEnd, panes, background = false, groupId }: SessionDockProps) {
  const dict = useDict();
  const rootRef = useRef<HTMLDivElement>(null);
  const open = dock.panes.length > 0;
  const present = useDockPresence(open);

  // What is drawn while it closes. The panes are gone from `dock` (and from
  // `panes`) the instant it closes, which would empty the panel before it has
  // gone; the last open state is what stays on screen until it has.
  const lastOpen = useRef({ dock, panes });
  if (open) lastOpen.current = { dock, panes };
  const drawn = open ? { dock, panes } : lastOpen.current;

  const { startDrag, isDragging: isWidthDragging } = usePanelDrag(dock.width, onWidthChange, onDragEnd);

  // A tab in the background keeps its dock mounted (a room's), but its rail is
  // not the group's: the one on screen is.
  const slotGroup = background ? null : groupId;
  const slotRef = useCallback((node: HTMLDivElement) => (slotGroup ? setPanelTogglesSlot(slotGroup, node) : undefined), [slotGroup]);

  const bounds = dockWidthBounds(drawn.dock.panes);
  const commitWidth = (width: number): void => {
    onWidthChange(width);
    onDragEnd();
  };
  // The edge is on the column's left: ArrowLeft moves it left, widening it.
  const onEdgeKeyDown = (event: React.KeyboardEvent): void => {
    const next =
      event.key === "ArrowLeft" ? dock.width + KEY_STEP
      : event.key === "ArrowRight" ? dock.width - KEY_STEP
      : event.key === "Home" ? bounds.min
      : event.key === "End" ? bounds.max
      : null;
    if (next === null) return;
    event.preventDefault();
    commitWidth(next);
  };

  const maximizedOpen = present && drawn.dock.maximized !== null;
  // A maximized pane fills the plane, so there is no side to be on. Closed,
  // the rail is still beside the plane, outside its frame.
  const sideWidth = open ? dock.width + DOCK_RAIL_WIDTH : DOCK_RAIL_WIDTH;
  useDockFrameCut(rootRef, !maximizedOpen && !background, sideWidth);

  return (
    <div
      ref={rootRef}
      // The window chrome's colour and one divider on the canvas side, like
      // the room's side panel: it sits beside the framed plane, not in a box
      // of its own (`useDockFrameCut` takes the frame away from behind it).
      // The width is what animates. It is the one box, `contain`ed so that
      // what changes inside it is not the page's to lay out, with a child
      // (below) that is never narrower than the open dock, so opening does not
      // re-wrap its content on every frame; and the
      // transition is off while the width is being dragged, or the panel would
      // trail the pointer. Closed, what is left is the rail.
      className={cn(
        // `ml-auto` keeps the right edge put when the chat leaves the flow to
        // make room, so a maximized pane grows leftwards from where it was.
        // Maximized is `100%` rather than `auto`/`flex-1` so it is a length
        // like the others: it transitions, and it follows the plane frame by
        // frame when the sidebar or a split group moves under it.
        "relative ml-auto h-full shrink-0 overflow-hidden border-l border-border-soft bg-bg-chrome",
        !isWidthDragging && "transition-[width] duration-(--motion-medium) ease-(--motion-ease) motion-reduce:transition-none",
      )}
      style={{ width: open && drawn.dock.maximized ? "100%" : sideWidth, contain: "layout paint" }}
    >
      {/* The content, at the width it will have, fading in as the box opens
       * (a beat behind it, so the text arrives once there is room for it) and
       * out as it closes. */}
      <div
        className={cn(
          "relative h-full transition-opacity duration-(--motion-medium) ease-(--motion-ease) motion-reduce:transition-none",
          open ? "opacity-100 delay-(--motion-fast)" : "pointer-events-none opacity-0",
        )}
        // Follows the box, so what is in the pane (its header buttons
        // included) moves with the edge instead of jumping to the final
        // layout; never narrower than the open dock, so opening from the rail
        // alone still does not re-wrap it. The rail's width is kept clear on
        // the right, where the rail is drawn over it.
        style={{ width: "100%", minWidth: dock.width + DOCK_RAIL_WIDTH, paddingRight: DOCK_RAIL_WIDTH }}
      >
        {present && !drawn.dock.maximized && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={dict.panels.resize}
            aria-valuenow={dock.width}
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={onEdgeKeyDown}
            onDoubleClick={() => commitWidth(DEFAULT_DOCK_WIDTH)}
            className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize hover:bg-border focus-visible:bg-border focus-visible:outline-none"
          />
        )}

        <div className="flex h-full w-full flex-col">
          {drawn.dock.panes.map((kind) => (
            <div key={kind} data-dock-pane={kind} className="relative min-h-0 w-full flex-1">
              {drawn.panes[kind]}
            </div>
          ))}
        </div>
      </div>

      <div
        data-testid="dock-rail"
        // Pinned to the right edge, so it stays put while the panel beside it
        // opens and closes, and opaque, so the panel's content never shows
        // under it while it slides.
        className="absolute top-0 right-0 bottom-0 z-20 flex flex-col bg-bg-chrome pt-1"
        style={{ width: DOCK_RAIL_WIDTH }}
      >
        {/* The slot the pane buttons are portaled into. `display: contents`
         * keeps the buttons themselves as the rail's flex items. */}
        <div ref={slotRef} className="contents" />
        {/* The panes' own buttons end here; what is under the divider adds to them. */}
        <div aria-hidden="true" className="mx-auto my-1 h-px w-5 shrink-0 bg-border" />
        <RailAddButton />
      </div>
    </div>
  );
}
