import { PanelRight } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface RightPanelToggleButtonProps {
  /** Whether the group's right-hand panel is showing. */
  shown: boolean;
  onToggle: () => void;
}

/**
 * The strip's right-hand end, the mirror of the title bar's sidebar toggle:
 * always there, over the side panel's rail. Hiding the panel leaves the rail
 * and its buttons; showing it brings back what was open.
 * One glyph for both states, drawn brighter while the panel shows, like the
 * sidebar's, so it reads as one control rather than two trading places.
 */
export function RightPanelToggleButton({ shown, onToggle }: RightPanelToggleButtonProps) {
  const dict = useDict();
  const label = shown ? dict.panels.hideRightPanel : dict.panels.showRightPanel;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          aria-pressed={shown}
          className={cn(
            "flex h-[30px] w-10 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground",
            shown && "text-foreground",
          )}
        >
          <PanelRight className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
