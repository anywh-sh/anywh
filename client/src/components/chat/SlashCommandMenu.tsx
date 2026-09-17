import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SlashCommandEntry } from "@/lib/composer/slashCommands";
import { cn } from "@/lib/utils";

interface SlashCommandMenuProps {
  items: SlashCommandEntry[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onPick: (entry: SlashCommandEntry) => void;
}

/**
 * Composer autocomplete popup — opens only when `/` is the
 * first character typed (see Tiptap's `Suggestion` in Composer.tsx).
 * Dressed as the app's other menus: same surface, same border, same single
 * elevation, and the command names in mono, which is what every control
 * label wears here.
 *
 * The selected/hovered item's description appears as a real tooltip on the
 * right side (project's `Tooltip`, `side="right"`) — `open` controlled by
 * the selected index instead of Radix's native hover, so it works the same
 * whether navigating by keyboard or mousing over.
 */
export function SlashCommandMenu({ items, selectedIndex, onHover, onPick }: SlashCommandMenuProps) {
  if (items.length === 0) return null;

  return (
    <ul className="z-50 max-h-56 w-48 overflow-y-auto border border-border bg-popover p-1 shadow-popover">
      {items.map((entry, index) => (
        <li key={entry.command}>
          <Tooltip open={index === selectedIndex}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onMouseEnter={() => onHover(index)}
                onClick={() => onPick(entry)}
                className={cn(
                  "block w-full cursor-pointer truncate px-2 py-1.5 text-left font-mono text-[11.5px] transition-colors",
                  index === selectedIndex ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-surface-hover",
                )}
              >
                {entry.command}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{entry.description}</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
