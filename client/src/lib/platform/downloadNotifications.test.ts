import { describe, expect, it, vi } from "vitest";
import {
  dismissDownloadNotification,
  finishBatchDownload,
  getDownloadNotifications,
  notifyFileDownloaded,
  startBatchDownload,
  subscribeDownloadNotifications,
  tickBatchDownload,
} from "@/lib/platform/downloadNotifications";

describe("downloadNotifications", () => {
  it("starts a batch at 0/total and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDownloadNotifications(listener);

    const id = startBatchDownload(5);

    expect(getDownloadNotifications().find((entry) => entry.id === id)).toEqual({ id, total: 5, current: 0, done: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    dismissDownloadNotification(id);
  });

  it("ticks the current count as files complete, without touching total or done", () => {
    const id = startBatchDownload(3);
    tickBatchDownload(id, 1);
    tickBatchDownload(id, 2);

    expect(getDownloadNotifications().find((entry) => entry.id === id)).toEqual({ id, total: 3, current: 2, done: false });
    dismissDownloadNotification(id);
  });

  it("marks a batch done and keeps it until explicitly dismissed", () => {
    const id = startBatchDownload(2);
    tickBatchDownload(id, 2);
    finishBatchDownload(id);

    expect(getDownloadNotifications().find((entry) => entry.id === id)?.done).toBe(true);

    dismissDownloadNotification(id);
    expect(getDownloadNotifications().find((entry) => entry.id === id)).toBeUndefined();
  });

  it("reports a lone-file download already done, carrying its file name, until dismissed", () => {
    notifyFileDownloaded("report.pdf");

    const entry = getDownloadNotifications().find((candidate) => candidate.fileName === "report.pdf");
    expect(entry).toMatchObject({ total: 1, current: 1, done: true, fileName: "report.pdf" });

    dismissDownloadNotification(entry!.id);
    expect(getDownloadNotifications().find((candidate) => candidate.fileName === "report.pdf")).toBeUndefined();
  });
});
