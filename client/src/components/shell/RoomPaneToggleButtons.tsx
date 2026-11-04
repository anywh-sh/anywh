import { Bot, Info } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface RoomPaneToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

const BUTTON_CLASS =
  "flex size-[30px] shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground";

/**
 * A room's own buttons in its group's strip, after files and terminal (see
 * `panelTogglesSlot.ts`): what the room says about itself, and the
 * conversation of the agent looked at last. Raw `<button>` markup like the
 * ones beside them.
 */
export function RoomAboutToggleButton({ open, onToggle }: RoomPaneToggleButtonProps) {
  const dict = useDict();
  const label = open ? dict.panels.closeRoomAbout : dict.panels.openRoomAbout;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onToggle} aria-label={label} className={cn(BUTTON_CLASS, open && "text-foreground")}>
          <Info className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function RoomAgentToggleButton({ open, onToggle }: RoomPaneToggleButtonProps) {
  const dict = useDict();
  const label = open ? dict.panels.closeAgent : dict.panels.openAgent;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onToggle} aria-label={label} className={cn(BUTTON_CLASS, "text-room-agent/70 hover:text-room-agent", open && "text-room-agent")}>
          <Bot className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
