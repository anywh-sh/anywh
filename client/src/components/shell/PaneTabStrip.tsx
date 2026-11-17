import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabTrigger } from "@/components/ui/tab-trigger";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { handleRovingKeyDown } from "@/lib/rovingKeys";
import { useDict } from "@/i18n";
import { cn, scrollHorizontallyOnWheel } from "@/lib/utils";

export interface PaneTab {
  id: string;
  label: string;
  /** File panel's preview tab — unpinned, shown in
   * italic, same convention as VS Code/Claude Desktop. The terminal never
   * sets this (every terminal tab is "pinned"). */
  italic?: boolean;
}

interface PaneTabStripProps {
  tabs: PaneTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Absent for the files pane — there's no "new file" in a read-only
   * viewer, unlike the terminal's "+". */
  onAdd?: () => void;
  addLabel?: string;
}

/** Generic tab strip for a dock pane's header — "Terminal 1 / Terminal 2 / +"
 * for the terminal, open files for the file viewer. Was `TerminalTabStrip`
 * before it generalized to both panes; no drag-to-reorder (unlike
 * the sessions' `TabGroupStrip`) — the number of tabs per pane tends to be small
 * enough not to justify dnd-kit's complexity here.
 *
 * Tabs sit flush against each other, divided by a border rather than by a
 * gap, and the active one is marked by its surface plus an accent underline.
 * The × is always there at reduced opacity instead of appearing on hover —
 * same decision the conversation strip made, for the same reason: a control
 * that materializes under the pointer can't be aimed at.
 */
export function PaneTabStrip({ tabs, activeId, onSelect, onClose, onAdd, addLabel }: PaneTabStripProps) {
  const dict = useDict();

  return (
    <div
      onWheel={scrollHorizontallyOnWheel}
      // See TabGroupStrip's identical comment: `overflow-x-auto` alone implies
      // `overflow-y: auto` too per spec, so this strip needs `overflow-y-hidden`
      // spelled out to stay horizontal-only when it gets squeezed.
      className="scrollbar-thin flex h-8 items-stretch overflow-x-auto overflow-y-hidden"
    >
      <div role="tablist" onKeyDown={(event) => handleRovingKeyDown(event, "tab")} className="flex items-stretch">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "relative flex shrink-0 items-center border-r border-border-soft font-mono text-[11px]",
              tab.id === activeId
                ? "bg-bg-elevated text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {/* The × is the trigger's sibling, laid over its reserved right
                padding: a button can't hold a button. */}
            <TabTrigger selected={tab.id === activeId} onClick={() => onSelect(tab.id)} className="flex h-full items-center py-1 pr-[26px] pl-2.5">
              <span className={cn("block max-w-24 truncate", tab.italic && "italic")}>{tab.label}</span>
            </TabTrigger>
            <Button
              variant="quiet"
              size="icon-xs"
              onClick={() => onClose(tab.id)}
              aria-label={dict.panels.closeTab.replace("{name}", tab.label)}
              className="absolute right-1.5 size-4 hover:text-destructive"
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
      </div>
      {onAdd && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chrome"
              size="icon"
              onClick={onAdd}
              aria-label={addLabel ?? dict.panels.terminal.newTerminal}
              className="h-auto w-7 text-text-faint"
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{addLabel ?? dict.panels.terminal.newTerminal}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
