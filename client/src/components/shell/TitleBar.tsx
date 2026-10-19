import { ChevronLeft, ChevronRight, Menu, PanelLeft, RefreshCw, Settings } from "lucide-react";
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
      className={cn("flex h-10 shrink-0 items-center gap-0.5 pr-1.5 pl-1.5 select-none", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}
    >
      <div className="contents">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={dict.shell.titleBar.menu}>
                  <Menu className="size-4" />
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
              <Button variant="ghost" size="icon-sm" onClick={onToggleSidebar} aria-label={sidebarLabel}>
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

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
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
              size="icon-sm"
              onClick={onGoForward}
              disabled={!canGoForward}
              aria-label={dict.shell.titleBar.forward}
            >
              <ChevronRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{dict.shell.titleBar.forward}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
