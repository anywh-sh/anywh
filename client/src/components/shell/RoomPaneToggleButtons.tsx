import { Bot, Info } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RailSelectedMark, railButtonClass } from "@/components/shell/railButton";
import { cn } from "@/lib/utils";

interface RoomPaneToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

/**
 * A room's own buttons in its group's side panel rail, under files and
 * terminal (see `panelTogglesSlot.ts`): what the room says about itself, and
 * the conversation of the agent looked at last. Raw `<button>` markup like
 * the ones above them.
 */
export function RoomAboutToggleButton({ open, onToggle }: RoomPaneToggleButtonProps) {
  const dict = useDict();
  const label = open ? dict.panels.closeRoomAbout : dict.panels.openRoomAbout;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onToggle} aria-label={label} className={railButtonClass(open)}>
          <RailSelectedMark selected={open} />
          <Info className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

export function RoomAgentToggleButton({ open, onToggle }: RoomPaneToggleButtonProps) {
  const dict = useDict();
  const label = open ? dict.panels.closeAgent : dict.panels.openAgent;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onToggle} aria-label={label} className={cn(railButtonClass(open), "text-room-agent/70 hover:text-room-agent", open && "text-room-agent")}>
          <RailSelectedMark selected={open} />
          <Bot className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
