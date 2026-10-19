import { ChevronLeft, ChevronRight, PanelLeft, RefreshCw, Settings, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { MAC_TRAFFIC_LIGHTS_INSET } from "@/components/shell/WindowControls";
import { useDict } from "@/i18n";
import { isMacOS, shortcutLabel } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

export function TitleBar({
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  showSidebarToggle,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSettings,
  onCheckForUpdates,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  showSidebarToggle: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onCheckForUpdates: () => void;
}) {
  const dict = useDict();
  const sidebarLabel = sidebarCollapsed ? dict.shell.titleBar.expandSidebar : dict.shell.titleBar.collapseSidebar;

  return (
    <div
      data-tauri-drag-region
      className={cn("flex h-10 shrink-0 items-center gap-1 pr-2 pl-1.5 select-none", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}
    >
      {/* History first, then the two controls the design puts at the right of
       * the column — settings and the sidebar switch. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm" className="size-[30px]"
            onClick={onGoBack}
            disabled={!canGoBack}
            aria-label={dict.shell.titleBar.back}
          >
            <ChevronLeft className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{dict.shell.titleBar.back}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm" className="size-[30px]"
            onClick={onGoForward}
            disabled={!canGoForward}
            aria-label={dict.shell.titleBar.forward}
          >
            <ChevronRight className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{dict.shell.titleBar.forward}</TooltipContent>
      </Tooltip>
      <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
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
      {showSidebarToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-[30px]" onClick={onToggleSidebar} aria-label={sidebarLabel}>
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
