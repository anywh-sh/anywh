import { describe, expect, it, vi } from "vitest";
import {
  cancelDownload,
  dismissDownloadNotification,
  finishDownload,
  getDownloadNotifications,
  reportDownloadBytes,
  startBatchDownload,
  startFileDownload,
  subscribeDownloadNotifications,
  tickBatchDownload,
} from "@/lib/platform/downloadNotifications";

const find = (id: string) => getDownloadNotifications().find((entry) => entry.id === id);

describe("downloadNotifications", () => {
  it("starts a batch at 0/total with its byte size and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDownloadNotifications(listener);

    const id = startBatchDownload(5, 2048);

    expect(find(id)).toEqual({ id, total: 5, current: 0, bytesTotal: 2048, bytesReceived: 0, done: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    dismissDownloadNotification(id);
  });

  it("ticks the file count and the bytes independently", () => {
    const id = startBatchDownload(3, 300);
    tickBatchDownload(id, 1);
    reportDownloadBytes(id, 150);

    expect(find(id)).toMatchObject({ total: 3, current: 1, bytesTotal: 300, bytesReceived: 150, done: false });
    dismissDownloadNotification(id);
  });

  it("lets a reported size replace the listed one", () => {
    const id = startFileDownload("report.pdf", 100);
    reportDownloadBytes(id, 40, 400);

    expect(find(id)).toMatchObject({ bytesTotal: 400, bytesReceived: 40 });
    dismissDownloadNotification(id);
  });

  it("starts a lone file running, carrying its name, and counts it once finished", () => {
    const id = startFileDownload("report.pdf", 10);
    expect(find(id)).toMatchObject({ fileName: "report.pdf", total: 1, current: 0, done: false });

    finishDownload(id);
    expect(find(id)).toMatchObject({ current: 1, done: true });
    dismissDownloadNotification(id);
    expect(find(id)).toBeUndefined();
  });

  it("keeps a finished download until explicitly dismissed", () => {
    const id = startBatchDownload(2, 0);
    tickBatchDownload(id, 2);
    finishDownload(id);

    expect(find(id)?.done).toBe(true);
    dismissDownloadNotification(id);
    expect(find(id)).toBeUndefined();
  });

  it("cancelling aborts through the start callback and removes the toast", () => {
    const abort = vi.fn();
    const id = startFileDownload("big.iso", 1 << 30, abort);

    cancelDownload(id);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(find(id)).toBeUndefined();
  });

  it("a finished download no longer aborts anything", () => {
    const abort = vi.fn();
    const id = startFileDownload("done.txt", 1, abort);
    finishDownload(id);

    cancelDownload(id);

    expect(abort).not.toHaveBeenCalled();
  });
});
