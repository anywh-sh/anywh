import { File } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { RailSelectedMark, railButtonClass } from "@/components/shell/railButton";

interface FilesToggleButtonProps {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * Work dir file panel button — portaled by a tab's `ChatPanel` into its
 * group's side panel rail (see `panelTogglesSlot.ts`), right under the
 * panel's own toggle and above `TerminalToggleButton`. Raw `<button>` markup,
 * not the shared `Button` component, like the toggle above it. Only the
 * group's own active tab ever claims the slot, so this reflects that tab's
 * state, not a fixed per-tab instance.
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
          className={railButtonClass(open)}
        >
          <RailSelectedMark selected={open} />
          <File className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {open ? dict.panels.closeFiles : dict.panels.openFiles}
        {/* Literal Ctrl even on macOS — VS Code's own Explorer shortcut,
         * same reasoning as the terminal's `Ctrl+\``. */}
        <TooltipShortcut>Ctrl+Shift+E</TooltipShortcut>
      </TooltipContent>
    </Tooltip>
  );
}
