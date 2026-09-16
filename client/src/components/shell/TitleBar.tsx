import { ChevronLeft, ChevronRight, Menu, PanelLeft, RefreshCw, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { MAC_TRAFFIC_LIGHTS_INSET, WindowControls } from "@/components/shell/WindowControls";
import { useDict } from "@/i18n";
import { isMacOS, shortcutLabel } from "@/lib/platform";
import { setTitleBarSlot } from "@/lib/titleBarSlot";
import { cn } from "@/lib/utils";

export function TitleBar({
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  showSidebarToggle,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSearch,
  onOpenSettings,
  onCheckForUpdates,
  connected,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  showSidebarToggle: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onCheckForUpdates: () => void;
  /** Unlike `MobileTopBar`, only rendered when `false` — desktop had no
   * connection feedback at all: a relay that's unreachable from the start
   * (wrong profile host/port, nothing running there) looked identical to
   * "the app is just loading", with every panel (folder picker, model/mode,
   * message send) failing silently or hanging instead. */
  connected: boolean;
}) {
  const dict = useDict();
  const sidebarLabel = sidebarCollapsed ? dict.shell.titleBar.expandSidebar : dict.shell.titleBar.collapseSidebar;

  return (
    <div className={cn("flex h-10 shrink-0 select-none border-b border-border bg-bg-chrome", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}>
      <div className="flex h-full shrink-0 items-center gap-0.5 px-1.5">
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onOpenSearch} aria-label={dict.shell.titleBar.searchSessions}>
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {dict.shell.titleBar.searchSessions}
            <TooltipShortcut>{shortcutLabel("K")}</TooltipShortcut>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* The center is both the window's drag region and the slot the focused
       * conversation portals its working directory into (`titleBarSlot.ts`).
       * `data-tauri-drag-region` only applies to this element itself, not to
       * children, so the button rendered inside stays clickable. */}
      <div
        data-tauri-drag-region
        ref={setTitleBarSlot}
        className="flex h-full min-w-0 flex-1 items-center justify-center gap-2 px-2"
      >
        {!connected && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-destructive">
            <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            {dict.shell.titleBar.reconnecting}
          </span>
        )}
      </div>

      <WindowControls />
    </div>
  );
}
