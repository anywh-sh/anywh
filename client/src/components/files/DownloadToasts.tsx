import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDownloadNotifications } from "@/hooks/media/useDownloadNotifications";
import { useDict } from "@/i18n";
import type { Dictionary } from "@/i18n/dictionary";
import { formatBytes } from "@/lib/format/bytes";
import { cancelDownload, dismissDownloadNotification, type DownloadNotification } from "@/lib/platform/downloadNotifications";

type DownloadsCopy = Dictionary["panels"]["files"]["downloads"];

function titleText(notification: DownloadNotification, copy: DownloadsCopy): string {
  if (notification.fileName) return (notification.done ? copy.fileDone : copy.fileProgress).replace("{name}", notification.fileName);
  return (notification.done ? copy.done : copy.progress)
    .replace("{current}", String(notification.current))
    .replace("{total}", String(notification.total));
}

/** Share of the bytes in, 0-100. Never 100 while running: a size that grew
 * since it was listed must not show a full bar on an unfinished download. */
export function downloadPercent(notification: DownloadNotification): number {
  if (notification.done) return 100;
  if (notification.bytesTotal <= 0) return 0;
  return Math.min(99, Math.floor((notification.bytesReceived / notification.bytesTotal) * 100));
}

function detailText(notification: DownloadNotification, copy: DownloadsCopy): string {
  if (notification.done) return formatBytes(Math.max(notification.bytesReceived, notification.bytesTotal));
  const received = formatBytes(notification.bytesReceived);
  if (notification.bytesTotal <= 0) return copy.bytesReceived.replace("{received}", received);
  return copy.bytesProgress
    .replace("{received}", received)
    .replace("{total}", formatBytes(notification.bytesTotal))
    .replace("{percent}", String(downloadPercent(notification)));
}

/** One download's card, rendered by sonner inside its toast. Reads its own
 * entry from the store, so progress re-renders only this card and the toast
 * itself is created once. */
function DownloadToastCard({ id }: { id: string }) {
  const copy = useDict().panels.files.downloads;
  const notification = useDownloadNotifications().find((entry) => entry.id === id);
  if (!notification) return null;
  const percent = downloadPercent(notification);
  const running = !notification.done;

  return (
    <div
      // Fills sonner's toast box: a card stacked behind a shorter front one
      // is clipped to the front card's height instead of spilling under it.
      className="flex h-full w-(--width) items-start gap-2.5 overflow-hidden border border-border bg-popover px-4 py-3 font-mono text-[11px] text-popover-foreground shadow-popover"
      title={notification.fileName}
    >
      <span className="flex h-4 shrink-0 items-center">
        {running ? (
          // Same "in progress" language as SessionListItem/TabGroupStrip's
          // running-session spinner.
          <Spinner size="lg" />
        ) : (
          <CheckCircle2 className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate leading-4">{titleText(notification, copy)}</span>
        {running && (
          <div
            role="progressbar"
            aria-label={titleText(notification, copy)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-0.5 w-full overflow-hidden bg-border"
          >
            <div className="h-full bg-foreground transition-[width] duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none" style={{ width: `${String(percent)}%` }} />
          </div>
        )}
        <span className="truncate text-muted-foreground tabular-nums">{detailText(notification, copy)}</span>
      </div>
      <Button
        variant="quiet"
        size="icon-xs"
        onClick={() => (running ? cancelDownload(id) : dismissDownloadNotification(id))}
        aria-label={running ? copy.cancel : copy.dismiss}
        // Same close-button treatment as the pane tabs' own × — always
        // visible, faint until pointed at. While running it cancels.
        className="-mr-1 size-[18px]"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * Bridges the download store to the app's toast stack (`Toaster`,
 * components/ui/sonner.tsx): one toast per download, created when the
 * download starts and removed when its entry leaves the store (dismissed or
 * cancelled). Several downloads pile up as sonner's stack and fan out on
 * hover rather than growing a column. No auto-dismiss: a finished toast
 * stays until its own × is clicked, so "Downloaded X/Y files" doesn't
 * vanish before the user notices it. Swiping is off for the same reason —
 * the × is the one way out, and while running it means cancel.
 */
export function DownloadToasts() {
  const notifications = useDownloadNotifications();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const live = new Set(notifications.map((entry) => entry.id));
    for (const id of live) {
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      toast.custom(() => <DownloadToastCard id={id} />, { id, duration: Infinity, dismissible: false, unstyled: true });
    }
    for (const id of shown.current) {
      if (live.has(id)) continue;
      shown.current.delete(id);
      toast.dismiss(id);
    }
  }, [notifications]);

  return null;
}
