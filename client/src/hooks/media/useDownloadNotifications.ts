import { useSyncExternalStore } from "react";
import { getDownloadNotifications, subscribeDownloadNotifications, type DownloadNotification } from "@/lib/platform/downloadNotifications";

/** Reactive read of the download toast stack — re-renders whenever any
 * in-flight or just-finished download (folder, bulk multi-select, or a lone
 * file) changes state. */
export function useDownloadNotifications(): DownloadNotification[] {
  return useSyncExternalStore(subscribeDownloadNotifications, getDownloadNotifications);
}
