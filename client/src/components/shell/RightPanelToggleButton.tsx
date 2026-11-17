import { PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
        <Button variant="chrome" size="icon" onClick={onToggle} aria-label={label} aria-pressed={shown} className="h-[30px] w-10 hover:bg-bg-hover">
          <PanelRight className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
