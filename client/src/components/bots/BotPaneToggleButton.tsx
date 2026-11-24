import { ListTodo } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RailButton } from "@/components/shell/railButton";
import { useDict } from "@/i18n";

/** A bot conversation's button in its group's side panel rail: the bot's
 * task list and automations. `attention` (a task waiting on the person) puts
 * a dot on the icon — the same mark the sidebar and the task list use — so a
 * question is visible with the panel closed. */
export function BotPaneToggleButton({ open, onToggle, attention = false }: { open: boolean; onToggle: () => void; attention?: boolean }) {
  const dict = useDict();
  const action = open ? dict.bots.panel.close : dict.bots.panel.open;
  const label = attention ? `${action} · ${dict.bots.task.status.needs_you}` : action;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RailButton onClick={onToggle} aria-label={label} selected={open}>
          <span className="relative flex">
            <ListTodo className="size-4" />
            {attention && <span data-testid="bot-pane-attention" aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" />}
          </span>
        </RailButton>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
