import { Fragment, useRef, type ReactNode } from "react";
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
 * closing just snaps its width to 0 instead of unmounting.
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
  const { startDrag } = usePanelDrag(dock.width, onWidthChange, onDragEnd);
  const { isDragging: isSplitDragging, startDrag: startSplitDrag } = useSplitDrag(dock.splitRatio, onSplitRatioChange, stackRef, onDragEnd);

  const open = dock.panes.length > 0;
  const maximizedOpen = open && dock.maximized !== null;

  return (
    <div
      className={cn("relative h-full shrink-0 overflow-hidden border-l border-border-soft bg-bg-sidebar", maximizedOpen && "flex-1")}
      style={{ width: open ? (dock.maximized ? undefined : dock.width) : 0 }}
    >
      {open && !dock.maximized && (
        <div
          onPointerDown={startDrag}
          className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize hover:bg-border"
        />
      )}

      <div ref={stackRef} className="flex h-full w-full flex-col">
        {dock.panes.map((kind, index) => {
          const isMaximized = dock.maximized === kind;
          const hiddenByMaximize = dock.maximized !== null && !isMaximized;
          const fillsWhole = dock.maximized !== null || dock.panes.length === 1;
          const flexBasis = index === 0 ? dock.splitRatio : 1 - dock.splitRatio;

          return (
            <Fragment key={kind}>
              {index === 1 && dock.maximized === null && (
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
                {panes[kind]}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
