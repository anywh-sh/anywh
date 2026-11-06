import { Plus } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { railButtonClass } from "@/components/shell/railButton";

/**
 * The rail's last button, under the divider that ends the panes' own: where
 * views from other platforms (an issue tracker, say) will be added to the
 * panel. Nothing is offered yet, so it has nothing to open.
 */
export function RailAddButton({ onAdd }: { onAdd?: () => void }) {
  const dict = useDict();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onAdd} aria-label={dict.panels.addView} className={railButtonClass(false)}>
          <Plus className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{dict.panels.addView}</TooltipContent>
    </Tooltip>
  );
}
