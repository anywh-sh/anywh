import { Fragment, useRef, type ReactNode } from "react";
import { useDockPresence } from "@/hooks/useDockPresence";
import { useDockFrameCut } from "@/hooks/useDockFrameCut";
import { usePanelDrag } from "@/hooks/tabs/usePanelDrag";
import { useSplitDrag } from "@/hooks/tabs/useSplitDrag";
import type { DockPaneKind, DockState } from "@/hooks/tabs/useSessionDock";
import { cn } from "@/lib/utils";

interface SessionDockProps {
  dock: DockState;
  onWidthChange: (width: number) => void;
  onSplitRatioChange: (ratio: number) => void;
  /** Fires once, on pointer up, after a width or split-ratio drag — flushes
   * the size to storage instead of writing on every `pointermove`. */
  onDragEnd: () => void;
  /** One entry per possible pane kind — `undefined`/absent for a kind that
   * isn't mounted at all (e.g. files pane not implemented yet, or lazily
   * not mounted). Only kinds present in `dock.panes` are actually rendered. */
  panes: Partial<Record<DockPaneKind, ReactNode>>;
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
 * Also owns the column-level resize handle (left edge, horizontal) and,
 * when two panes are stacked, the divider between them (split, vertical) —
 * both act on the column/split as a whole, not on an individual pane, which
 * is why `SessionPanel` no longer has an `onStartDrag`.
 */
export function SessionDock({ dock, onWidthChange, onSplitRatioChange, onDragEnd, panes }: SessionDockProps) {
  const stackRef = useRef<HTMLDivElement>(null);
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
  const { isDragging: isSplitDragging, startDrag: startSplitDrag } = useSplitDrag(dock.splitRatio, onSplitRatioChange, stackRef, onDragEnd);

  const maximizedOpen = present && drawn.dock.maximized !== null;
  // A maximized pane fills the plane, so there is no side to be on.
  useDockFrameCut(rootRef, present && !maximizedOpen, dock.width);

  return (
    <div
      ref={rootRef}
      // The window chrome's colour and one divider on the canvas side, like
      // the room's side panel: it sits beside the framed plane, not in a box
      // of its own (`useDockFrameCut` takes the frame away from behind it).
      // The width is what animates. It is the one box, `contain`ed so that
      // what changes inside it is not the page's to lay out, with a fixed-width
      // child (below) so its content is not re-wrapped on every frame; and the
      // transition is off while the width is being dragged, or the panel would
      // trail the pointer. The divider goes with the width, so a closed dock
      // leaves no sliver.
      className={cn(
        "relative h-full shrink-0 overflow-hidden bg-bg-chrome",
        present && "border-l border-border-soft",
        !isWidthDragging && "transition-[width] duration-(--motion-medium) ease-(--motion-ease) motion-reduce:transition-none",
        maximizedOpen && "flex-1",
      )}
      style={{ width: open ? (drawn.dock.maximized ? undefined : dock.width) : 0, contain: "layout paint" }}
    >
      {/* The content, at the width it will have, fading in as the box opens
       * (a beat behind it, so the text arrives once there is room for it) and
       * out as it closes. */}
      <div
        className={cn(
          "relative h-full transition-opacity duration-(--motion-medium) ease-(--motion-ease) motion-reduce:transition-none",
          open ? "opacity-100 delay-(--motion-fast)" : "opacity-0",
        )}
        style={{ width: drawn.dock.maximized ? "100%" : dock.width }}
      >
        {present && !drawn.dock.maximized && (
          <div
            onPointerDown={startDrag}
            className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize hover:bg-border"
          />
        )}

        <div ref={stackRef} className="flex h-full w-full flex-col">
          {drawn.dock.panes.map((kind, index) => {
            const isMaximized = drawn.dock.maximized === kind;
            const hiddenByMaximize = drawn.dock.maximized !== null && !isMaximized;
            const fillsWhole = drawn.dock.maximized !== null || drawn.dock.panes.length === 1;
            const flexBasis = index === 0 ? dock.splitRatio : 1 - dock.splitRatio;

            return (
              <Fragment key={kind}>
                {index === 1 && drawn.dock.maximized === null && (
                  <div
                    onPointerDown={startSplitDrag}
                    className={cn("h-1 w-full shrink-0 cursor-row-resize hover:bg-border", isSplitDragging && "bg-border")}
                  />
                )}
                {/* `invisible absolute inset-0` instead of unmounting or
                 * collapsing to zero size — same rule as `App.tsx`/`MessageLog.tsx`:
                 * a virtualized pane (the code viewer) would corrupt its
                 * `react-virtual` height cache if its container ever measured
                 * zero, even for an instant. */}
                <div
                  className={cn("relative min-h-0 w-full", hiddenByMaximize && "invisible absolute inset-0")}
                  style={hiddenByMaximize ? undefined : { flex: fillsWhole ? "1 1 0%" : `${flexBasis} 1 0%` }}
                >
                  {drawn.panes[kind]}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
