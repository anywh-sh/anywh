import { composeStories } from "@storybook/react-vite";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import * as stories from "./DownloadToasts.stories";
import { getDownloadNotifications } from "@/lib/platform/downloadNotifications";
import { en } from "@/i18n/en";

const copy = en.panels.files.downloads;
const { FileInProgress, FileDone, BatchInProgress, UnknownSize, Stacked, Simulated } = composeStories(stories);

describe("DownloadToasts stories", () => {
  afterEach(() => {
    act(() => cleanup());
    vi.useRealTimers();
  });

  it("clears the store when a story unmounts, so stories don't leak into each other", async () => {
    const { unmount } = render(<FileInProgress />);
    await screen.findByText(copy.fileProgress.replace("{name}", "dataset-2026-11.parquet"));
    act(() => unmount());
    expect(getDownloadNotifications()).toEqual([]);
  });

  it("shows a running file's bar and bytes", async () => {
    render(<FileInProgress />);
    expect(await screen.findByText("31 MB of 48 MB · 64%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "64");
  });

  it("shows a finished file with its size and a dismiss button, not a cancel", async () => {
    render(<FileDone />);
    expect(await screen.findByText(copy.fileDone.replace("{name}", "report.pdf"))).toBeInTheDocument();
    expect(screen.getByText("820 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.dismiss })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.cancel })).toBeNull();
  });

  it("counts files in a batch's title", async () => {
    render(<BatchInProgress />);
    expect(await screen.findByText(copy.progress.replace("{current}", "12").replace("{total}", "40"))).toBeInTheDocument();
  });

  it("drops the percentage when the size is unknown", async () => {
    render(<UnknownSize />);
    expect(await screen.findByText("0 B")).toBeInTheDocument();
  });

  it("stacks three downloads with one in front", async () => {
    render(<Stacked />);
    await waitFor(() => expect(document.body.querySelectorAll("[data-sonner-toast]")).toHaveLength(3));
    expect(document.body.querySelectorAll('[data-sonner-toast][data-front="true"]')).toHaveLength(1);
  });

  it("runs the simulated download to done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Simulated />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 33);
    });
    expect(await screen.findByText(copy.fileDone.replace("{name}", "video-capture.mp4"))).toBeInTheDocument();
  });

  it("stops the simulated download when cancelled from its ×", async () => {
    const user = userEvent.setup();
    render(<Simulated />);
    await user.click(await screen.findByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(getDownloadNotifications()).toEqual([]));
  });
});
