import { PanelLeft, RefreshCw, Settings, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateRestartButton } from "@/components/shell/UpdateRestartButton";
import { MAC_TRAFFIC_LIGHTS_INSET } from "@/components/shell/WindowControls";
import { useDict } from "@/i18n";
import { isMacOS, shortcutLabel } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

export function TitleBar({
  showSidebarToggle,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSettings,
  onCheckForUpdates,
}: {
  showSidebarToggle: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onCheckForUpdates: () => void;
}) {
  const dict = useDict();
  // With the sidebar folded away the bar keeps only the control that brings it
  // back; the menu returns with the sidebar.
  const showMenu = !(showSidebarToggle && sidebarCollapsed);
  const sidebarLabel = sidebarCollapsed ? dict.shell.titleBar.expandSidebar : dict.shell.titleBar.collapseSidebar;

  return (
    <div
      data-tauri-drag-region
      className={cn("flex h-10 shrink-0 items-center gap-1 pr-2 pl-1.5 select-none", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}
    >
      <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      <UpdateRestartButton />
      {showMenu && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-[30px]" aria-label={dict.shell.titleBar.menu}>
                  <SlidersHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{dict.shell.titleBar.menu}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuItem onSelect={onOpenSettings}>
              <Settings className="size-3.5" />
              {dict.shell.titleBar.settings}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCheckForUpdates}>
              <RefreshCw className="size-3.5" />
              {dict.shell.titleBar.checkForUpdates}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {showSidebarToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-[30px]"
              // The shortcut acts the moment the key goes down; a click acts when
              // the button comes back up, one press-and-release later — the gap
              // between a toggle that feels instant and one that does not. So a
              // pointer acts on the press, as the shortcut does, and the `click`
              // that follows it (it has a position, `detail` > 0) is left alone.
              // A `click` with none — from the keyboard, or an assistive
              // technology — is the only one that still acts.
              onPointerDown={(event) => {
                if (event.button === 0) onToggleSidebar();
              }}
              onClick={(event) => {
                if (event.detail === 0) onToggleSidebar();
              }}
              aria-label={sidebarLabel}
            >
              {/* One icon for both states, not a pair that swaps: the
               * control is a toggle, and the design draws it as a panel
               * outline that fills in when the panel is showing. Swapping
               * the glyph makes the button look like two different
               * controls trading places every time it is pressed. */}
              <PanelLeft className={cn("size-4", !sidebarCollapsed && "text-foreground")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sidebarLabel}
            <TooltipShortcut>{shortcutLabel("B")}</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
