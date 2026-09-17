import type { ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { useWindowControls } from "@/hooks/platform/useWindowControls";
import { useDict } from "@/i18n";
import { isMacOS } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

/** No tooltip on purpose — these are the 3 native window controls (Windows
 * Fluent convention), universally recognizable without a label. */
function WindowControlButton({
  label,
  onClick,
  variant = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  variant?: "default" | "close";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-[46px] cursor-pointer items-center justify-center text-muted-foreground transition-colors",
        variant === "close" ? "hover:bg-destructive hover:text-foreground" : "hover:bg-surface-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Left padding a title bar needs on macOS: Tauri's overlay mode keeps the
 * native traffic lights there, so the bar draws nothing of its own on that
 * side and just reserves their space so nothing ends up underneath them. */
export const MAC_TRAFFIC_LIGHTS_INSET = "pl-[78px]";

/**
 * Minimize / maximize-or-restore / close, drawn by the app because the
 * window has no OS decorations (`tauri.conf.json`). Every bar that frames
 * the window — the shell's `TitleBar`, the first-run screen's own bar —
 * mounts this at its right edge. Renders nothing on macOS, where the native
 * controls are still there (see `MAC_TRAFFIC_LIGHTS_INSET`).
 */
export function WindowControls() {
  const dict = useDict();
  const { isMaximized, minimize, toggleMaximize, close } = useWindowControls();

  if (isMacOS()) return null;

  return (
    <div className="flex h-full shrink-0">
      <WindowControlButton label={dict.shell.titleBar.minimize} onClick={minimize}>
        <Minus className="size-3" strokeWidth={1.5} />
      </WindowControlButton>
      <WindowControlButton
        label={isMaximized ? dict.shell.titleBar.restore : dict.shell.titleBar.maximize}
        onClick={toggleMaximize}
      >
        {isMaximized ? <Copy className="size-3 -scale-x-100" strokeWidth={1.5} /> : <Square className="size-3" strokeWidth={1.5} />}
      </WindowControlButton>
      <WindowControlButton label={dict.shell.titleBar.close} onClick={close} variant="close">
        <X className="size-3.5" strokeWidth={1.5} />
      </WindowControlButton>
    </div>
  );
}
