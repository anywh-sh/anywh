import { SquareTerminal } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { RailSelectedMark, railButtonClass } from "@/components/shell/railButton";

interface TerminalToggleButtonProps {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * Embedded terminal button — portaled by a tab's `ChatPanel` into its
 * group's side panel rail (see `panelTogglesSlot.ts`), right under
 * `FilesToggleButton`. Same raw-`<button>` markup as the rest of the rail
 * (not the shared `Button` component) so they read as one column. Only the
 * group's own active tab ever claims the slot, so this reflects that tab's
 * state, not a fixed per-tab instance.
 */
export function TerminalToggleButton({ open, disabled, onToggle }: TerminalToggleButtonProps) {
  const dict = useDict();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          aria-label={open ? dict.panels.closeTerminal : dict.panels.openTerminal}
          className={railButtonClass(open)}
        >
          <RailSelectedMark selected={open} />
          <SquareTerminal className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {open ? dict.panels.closeTerminal : dict.panels.openTerminal}
        {/* Literal Ctrl even on macOS — VS Code's own convention, whose
         * integrated terminal shortcut uses Control on any OS because
         * Cmd+` is already reserved by macOS (switching between windows of
         * the same app), same reasoning as Ctrl+Tab in App.tsx. */}
        <TooltipShortcut>Ctrl+`</TooltipShortcut>
      </TooltipContent>
    </Tooltip>
  );
}
