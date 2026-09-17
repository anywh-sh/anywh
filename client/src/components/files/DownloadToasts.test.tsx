import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadToasts } from "@/components/files/DownloadToasts";
import {
  dismissDownloadNotification,
  finishBatchDownload,
  getDownloadNotifications,
  notifyFileDownloaded,
  startBatchDownload,
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
const fileDone = (name: string) => copy.fileDone.replace("{name}", name);

afterEach(() => {
  cleanup();
  // No auto-dismiss anymore (a toast only leaves via its own close button) —
  // without this, a notification left over from one test would still be in
  // the shared module store for the next one.
  act(() => {
    for (const entry of getDownloadNotifications()) dismissDownloadNotification(entry.id);
  });
});

describe("DownloadToasts", () => {
  it("renders nothing with no active download", () => {
    render(<DownloadToasts />);
    expect(document.body.querySelector(".fixed.bottom-4")).toBeNull();
  });

  it("shows the live count for a batch, then the done count once it finishes", () => {
    render(<DownloadToasts />);

    let id = "";
    act(() => {
      id = startBatchDownload(3);
    });
    expect(screen.getByText(progress(0, 3))).toBeInTheDocument();

    act(() => tickBatchDownload(id, 1));
    expect(screen.getByText(progress(1, 3))).toBeInTheDocument();

    act(() => {
      tickBatchDownload(id, 3);
      finishBatchDownload(id);
    });
    expect(screen.getByText(done(3, 3))).toBeInTheDocument();
  });

  it("shows the lone-file phrasing, truncated in a fixed-width toast, with the full name on hover", () => {
    render(<DownloadToasts />);

    const longName = "a-suspiciously-long-report-filename-nobody-should-actually-use.pdf";
    act(() => notifyFileDownloaded(longName));

    const toast = screen.getByText(fileDone(longName));
    expect(toast).toHaveClass("truncate");
    expect(toast.closest("div[title]")).toHaveAttribute("title", longName);
  });

  it("keeps a done toast on screen until its close button is clicked", async () => {
    const user = userEvent.setup();
    render(<DownloadToasts />);

    act(() => notifyFileDownloaded("report.pdf"));
    expect(screen.getByText(fileDone("report.pdf"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.dismiss }));
    expect(screen.queryByText(fileDone("report.pdf"))).toBeNull();
  });
});
