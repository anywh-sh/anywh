import type { ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDict } from "@/i18n";

interface SessionPanelProps {
  maximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
  /** Content specific to the pane's kind, in the header — e.g. the
   * terminal's tab strip. The shell doesn't know what it is. */
  headerExtra: ReactNode;
  children: ReactNode;
}

/**
 * Generic shell for one pane of the right-side dock — maximize/close,
 * without knowing anything about the content it hosts. Terminal is the
 * first consumer (`TerminalPanel`); the work dir file viewer reuses this
 * same shell, just swapping `headerExtra` and `children` (see
 * useSessionDock.ts for why the dock and each pane's content are separate
 * things). Width/split/open-close animation aren't this shell's
 * responsibility — `SessionDock` already delivers a space of the right size
 * (see comment there); this shell just fills 100% of it, including the
 * resize handle on the column's left edge and the divider between two
 * panes, both owned by `SessionDock` since they act on the column, not on
 * an individual pane.
 */
export function SessionPanel({ maximized, onToggleMaximized, onClose, headerExtra, children }: SessionPanelProps) {
  const dict = useDict();

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col bg-bg-chrome">
      {/* The header wears the chrome surface, like the title bar and the tab
        * strip above it — the panel's content is what should read as content.
        * No rules of its own: the panel is not a box, the plane's frame is the
        * one thing drawn around content. */}
      <div className="flex shrink-0 items-center justify-between bg-bg-chrome">
        <div className="min-w-0 flex-1">{headerExtra}</div>
        {/* Square, flush and the same height as the strip's own controls. */}
        <div className="flex h-8 shrink-0 items-stretch">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleMaximized}
                aria-label={maximized ? dict.panels.restore : dict.panels.maximize}
                className="h-full border-0 hover:border-0"
              >
                {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{maximized ? dict.panels.restore : dict.panels.maximize}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label={dict.panels.close}
                className="h-full border-0 hover:border-0 hover:text-destructive"
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{dict.panels.close}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
