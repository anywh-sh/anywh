import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadToasts } from "@/components/files/DownloadToasts";
import { Toaster } from "@/components/ui/sonner";
import {
  dismissDownloadNotification,
  finishDownload,
  getDownloadNotifications,
  reportDownloadBytes,
  startBatchDownload,
  startFileDownload,
  tickBatchDownload,
} from "@/lib/platform/downloadNotifications";
import { en } from "@/i18n/en";

const copy = en.panels.files.downloads;

/** The phrasings, read from the dictionary so this test doesn't become a
 * second place the wording lives. */
const progress = (current: number, total: number) =>
  copy.progress.replace("{current}", String(current)).replace("{total}", String(total));
const done = (current: number, total: number) =>
  copy.done.replace("{current}", String(current)).replace("{total}", String(total));
const fileProgress = (name: string) => copy.fileProgress.replace("{name}", name);
const fileDone = (name: string) => copy.fileDone.replace("{name}", name);
const bytes = (received: string, total: string, percent: number) =>
  copy.bytesProgress.replace("{received}", received).replace("{total}", total).replace("{percent}", String(percent));

function renderToasts() {
  return render(
    <>
      <Toaster />
      <DownloadToasts />
    </>,
  );
}

afterEach(() => {
  // No auto-dismiss (a toast only leaves via its own button) — without this,
  // a notification left over from one test would still be in the shared
  // module store for the next one.
  act(() => {
    for (const entry of getDownloadNotifications()) dismissDownloadNotification(entry.id);
  });
  cleanup();
});

describe("DownloadToasts", () => {
  it("renders no toast with no active download", () => {
    renderToasts();
    expect(document.body.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("shows a lone file as soon as it starts, with a progress bar and the bytes in", async () => {
    renderToasts();

    let id = "";
    act(() => {
      id = startFileDownload("video.mp4", 4 * 1024 * 1024);
    });
    expect(await screen.findByText(fileProgress("video.mp4"))).toBeInTheDocument();

    act(() => reportDownloadBytes(id, 1024 * 1024));
    expect(await screen.findByText(bytes("1.0 MB", "4.0 MB", 25))).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");

    act(() => finishDownload(id));
    expect(await screen.findByText(fileDone("video.mp4"))).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows the live count for a batch, then the done count once it finishes", async () => {
    renderToasts();

    let id = "";
    act(() => {
      id = startBatchDownload(3, 300);
    });
    expect(await screen.findByText(progress(0, 3))).toBeInTheDocument();

    act(() => tickBatchDownload(id, 1));
    expect(await screen.findByText(progress(1, 3))).toBeInTheDocument();

    act(() => {
      tickBatchDownload(id, 3);
      finishDownload(id);
    });
    expect(await screen.findByText(done(3, 3))).toBeInTheDocument();
  });

  it("stacks several downloads in one toast region instead of a column of cards", async () => {
    renderToasts();

    act(() => {
      startFileDownload("a.txt", 10);
      startFileDownload("b.txt", 10);
      startFileDownload("c.txt", 10);
    });

    await waitFor(() => expect(document.body.querySelectorAll("[data-sonner-toast]")).toHaveLength(3));
    expect(document.body.querySelectorAll("[data-sonner-toaster]")).toHaveLength(1);
    // Only the newest is in front; the others sit behind it in the stack.
    expect(document.body.querySelectorAll('[data-sonner-toast][data-front="true"]')).toHaveLength(1);
  });

  it("cancels a running download from its ×, which removes the toast", async () => {
    const user = userEvent.setup();
    renderToasts();

    let aborted = false;
    act(() => {
      startFileDownload("big.iso", 1 << 30, () => {
        aborted = true;
      });
    });

    await user.click(await screen.findByRole("button", { name: copy.cancel }));

    expect(aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText(fileProgress("big.iso"))).toBeNull());
  });

  it("keeps a done toast on screen until its close button is clicked", async () => {
    const user = userEvent.setup();
    renderToasts();

    act(() => {
      finishDownload(startFileDownload("report.pdf", 10));
    });
    expect(await screen.findByText(fileDone("report.pdf"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.dismiss }));
    await waitFor(() => expect(screen.queryByText(fileDone("report.pdf"))).toBeNull());
  });

  it("truncates a long file name, keeping the full name on hover", async () => {
    renderToasts();

    const longName = "a-suspiciously-long-report-filename-nobody-should-actually-use.pdf";
    act(() => {
      startFileDownload(longName, 10);
    });

    const title = await screen.findByText(fileProgress(longName));
    expect(title).toHaveClass("truncate");
    expect(title.closest("div[title]")).toHaveAttribute("title", longName);
  });
});
