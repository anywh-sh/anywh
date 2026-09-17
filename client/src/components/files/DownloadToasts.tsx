import { createPortal } from "react-dom";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { useDownloadNotifications } from "@/hooks/media/useDownloadNotifications";
import { useDict } from "@/i18n";
import type { Dictionary } from "@/i18n/dictionary";
import { dismissDownloadNotification, type DownloadNotification } from "@/lib/platform/downloadNotifications";

function toastText(notification: DownloadNotification, copy: Dictionary["panels"]["files"]["downloads"]): string {
  if (notification.fileName) return copy.fileDone.replace("{name}", notification.fileName);
  return (notification.done ? copy.done : copy.progress)
    .replace("{current}", String(notification.current))
    .replace("{total}", String(notification.total));
}

/**
 * Bottom-right download progress toasts, mirroring how Zed's
 * remote project panel reports a directory download: one line per
 * in-flight/just-finished batch, the count ticking up live. Stays on screen
 * until dismissed via its own close button — no auto-dismiss timer, so a
 * "Baixado X/Y arquivos" toast doesn't disappear before the user notices it.
 * Portaled to `document.body` on the same reasoning as `ContextMenuAnchor`
 * (useContextMenu.tsx) — a session tab's content sits inside
 * `TabGroupLayout`'s `contain: layout paint` wrapper, which would otherwise
 * turn this `fixed` stack's corner anchor into an offset from that wrapper
 * instead of the real viewport.
 */
export function DownloadToasts() {
  const copy = useDict().panels.files.downloads;
  const notifications = useDownloadNotifications();
  if (notifications.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          // `min-w-87.5` = 87.5 * the theme's 4px spacing unit = 350px
          // (Tailwind v4's spacing scale computes any numeric class against
          // `--spacing` instead of a fixed lookup table, so this is the
          // standard-scale way to hit an exact pixel target). `max-w-96`
          // raised alongside it — `min-w` past a smaller `max-w` would just
          // win and make the `max-w` dead weight.
          className="pointer-events-auto flex max-w-96 min-w-87.5 items-center gap-2.5 border border-border bg-popover px-4 py-3 font-mono text-[11px] text-popover-foreground shadow-popover"
          title={notification.fileName}
        >
          {notification.done ? (
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            // Same "in progress" language as SessionListItem/TabGroupStrip's
            // running-session spinner — a shared visual vocabulary for
            // "something's happening", not a download-specific icon choice.
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="truncate">{toastText(notification, copy)}</span>
          <button
            type="button"
            onClick={() => dismissDownloadNotification(notification.id)}
            aria-label={copy.dismiss}
            // Same close-button treatment as the pane tabs' own × — always
            // visible, faint until pointed at.
            className="ml-auto shrink-0 cursor-pointer p-0.5 text-text-faint transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
