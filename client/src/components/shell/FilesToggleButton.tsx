import { FolderTree } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface FilesToggleButtonProps {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * Work dir file panel button — portaled by a tab's `ChatPanel` into its
 * group's `TabGroupStrip` toggle slot (see `panelTogglesSlot.ts`), landing
 * immediately to the left of `TerminalToggleButton` and the group's `+`
 * (files, then terminal, then new tab). Same raw-`<button>` markup as `+`
 * (not the shared `Button` component) so the three read as one row of
 * border-separated actions. Only the group's own active tab ever claims the
 * slot, so this reflects that tab's state, not a fixed per-tab instance.
 */
export function FilesToggleButton({ open, disabled, onToggle }: FilesToggleButtonProps) {
  const dict = useDict();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          aria-label={open ? dict.panels.closeFiles : dict.panels.openFiles}
          className={cn(
            "flex w-9 shrink-0 cursor-pointer items-center justify-center border-l border-border-soft text-text-faint transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            open && "bg-bg-elevated text-foreground",
          )}
        >
          <FolderTree className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {open ? dict.panels.closeFiles : dict.panels.openFiles}
        {/* Literal Ctrl even on macOS — VS Code's own Explorer shortcut,
         * same reasoning as the terminal's `Ctrl+\``. */}
        <TooltipShortcut>Ctrl+Shift+E</TooltipShortcut>
      </TooltipContent>
    </Tooltip>
  );
}
