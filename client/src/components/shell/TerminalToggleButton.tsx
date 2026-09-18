import { SquareTerminal } from "lucide-react";
import { useDict } from "@/i18n";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TerminalToggleButtonProps {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * Embedded terminal button — portaled by a tab's `ChatPanel` into its
 * group's `TabGroupStrip` toggle slot (see `panelTogglesSlot.ts`), landing
 * immediately to the right of `FilesToggleButton` and to the left of the
 * group's `+` (files, then terminal, then new tab). Same raw-`<button>`
 * markup as `+` (not the shared `Button` component) so the three read as
 * one row of border-separated actions. Only the group's own active tab ever
 * claims the slot, so this reflects that tab's state, not a fixed per-tab
 * instance.
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
          className={cn(
            "flex w-9 shrink-0 cursor-pointer items-center justify-center border-l border-border-soft text-text-faint transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            open && "bg-bg-elevated text-foreground",
          )}
        >
          <SquareTerminal className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
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
