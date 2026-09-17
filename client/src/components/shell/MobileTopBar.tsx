import { Menu, Plus } from "lucide-react";
import { useKeyboardInset } from "@/hooks/platform/useKeyboardInset";
import { cn } from "@/lib/utils";
import { useDict } from "@/i18n";

interface MobileTopBarProps {
  title: string;
  connected: boolean;
  onOpenDrawer: () => void;
  onNewConversation: () => void;
}

/**
 * iOS's consolidated top bar — menu, active session title/status,
 * and "+ new conversation" in a single piece, replacing the standalone
 * connection capsule (Phase E) that had no session context at all.
 *
 * A v2 swapped this for separate circles + a blur zone — a misunderstanding
 * of the reference screenshot (the point was just "this is CSS, not real
 * native glass", not a request for a different layout). This unified shape
 * (single pill) is the approved one; what actually changes is the blur
 * intensity (it was too strong) and, eventually, swapping the CSS material
 * for real native Swift glass — see `tauri-plugin-native-chrome`.
 */
export function MobileTopBar({ title, connected, onOpenDrawer, onNewConversation }: MobileTopBarProps) {
  const dict = useDict();
  // Compensates `offsetTop` (see `useKeyboardInset`) — without this, opening
  // the keyboard visually slides this bar up and off the top of the screen
  // (WebKit pans the visual viewport for keyboard avoidance, but doesn't
  // reposition `position: absolute`/`fixed` elements, which stay anchored to
  // the layout viewport). Most visible on a screen with nothing scrollable
  // yet (a fresh "new conversation" tab).
  const { offsetTop } = useKeyboardInset();

  return (
    <div className="absolute inset-x-4 z-30" style={{ top: `calc(env(safe-area-inset-top) + 8px + ${offsetTop}px)` }}>
      <div className="flex h-13 items-center gap-1 rounded-full border border-glass-tint/8 bg-bg-elevated/45 px-1.5 shadow-lg backdrop-blur-lg backdrop-saturate-150">
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label={dict.shell.titleBar.openSidebar}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground transition-colors active:bg-glass-tint/10"
        >
          <Menu className="size-4.5" />
        </button>

        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
          <span className="w-full truncate text-center text-[14.5px] font-semibold">{title}</span>
          <span
            className={cn(
              "flex items-center gap-1.5 font-mono text-[11.5px]",
              connected ? "text-muted-foreground" : "text-destructive",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                connected ? "bg-muted-foreground" : "animate-pulse bg-destructive",
              )}
            />
            {connected ? "Conectado" : "Reconectando…"}
          </span>
        </div>

        <button
          type="button"
          onClick={onNewConversation}
          aria-label={dict.shell.sidebar.newConversation}
          className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground transition-colors active:bg-glass-tint/10"
        >
          <Plus className="size-4.5" />
        </button>
      </div>
    </div>
  );
}
