import { ListTodo } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RailButton } from "@/components/shell/railButton";
import { useDict } from "@/i18n";

/** A bot conversation's button in its group's side panel rail: the bot's
 * task list and automations. */
export function BotPaneToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const dict = useDict();
  const label = open ? dict.bots.panel.close : dict.bots.panel.open;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RailButton onClick={onToggle} aria-label={label} selected={open}>
          <ListTodo className="size-4" />
        </RailButton>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
