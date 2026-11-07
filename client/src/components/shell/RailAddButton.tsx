import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { railButtonClass } from "@/components/shell/railButton";

/** One view the "+" offers to add. */
export interface RailAddItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * The rail's last button, under the divider that ends the panes' own: where
 * views from other platforms (an issue tracker) are added to the panel. With
 * something to offer it opens a menu of it; with nothing, it has nothing to
 * open.
 */
export function RailAddButton({ items = [] }: { items?: readonly RailAddItem[] }) {
  const dict = useDict();
  const button = (
    <button type="button" aria-label={dict.panels.addView} className={railButtonClass(false)}>
      <Plus className="size-4" />
    </button>
  );
  if (items.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="left">{dict.panels.addView}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    // Not modal: Radix's modal focus trap breaks in WKWebView.
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{dict.panels.addView}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="left" align="start" className="min-w-40">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={item.onSelect}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
