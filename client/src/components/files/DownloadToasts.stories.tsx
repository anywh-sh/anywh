import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { DownloadToasts } from "@/components/files/DownloadToasts";
import {
  dismissDownloadNotification,
  finishDownload,
  getDownloadNotifications,
  reportDownloadBytes,
  startBatchDownload,
  startFileDownload,
  tickBatchDownload,
} from "@/lib/platform/downloadNotifications";

const MB = 1024 * 1024;

function clearDownloads(): void {
  for (const entry of getDownloadNotifications()) dismissDownloadNotification(entry.id);
}

/** Puts downloads in the store once the story mounts and clears them when
 * it unmounts — the store is module-level, so a story left running would
 * leak its toasts into the next one. `seed` may return its own cleanup (a
 * timer driving a simulated download). */
function Seed({ seed }: { seed: () => void | (() => void) }) {
  useEffect(() => {
    const stop = seed();
    return () => {
      stop?.();
      clearDownloads();
    };
  }, [seed]);
  return null;
}

/** A download that moves on its own, the way a real one reports bytes:
 * `chunk` bytes every `everyMs`, then finished. Cancelling from the toast
 * stops the timer, as an abort stops the fetch. */
export function simulateFile(name: string, size: number, chunk: number, everyMs: number): () => void {
  let received = 0;
  let id = "";
  const timer = setInterval(() => {
    received = Math.min(size, received + chunk);
    reportDownloadBytes(id, received, size);
    if (received >= size) {
      clearInterval(timer);
      finishDownload(id);
    }
  }, everyMs);
  id = startFileDownload(name, size, () => clearInterval(timer));
  return () => clearInterval(timer);
}

const meta = {
  title: "Files/DownloadToasts",
  component: DownloadToasts,
  excludeStories: /^[a-z]/,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-screen bg-background">
        <Toaster position="bottom-right" offset={{ bottom: 40, right: 12 }} />
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DownloadToasts>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A lone file partway through: title, bar, bytes and percentage. The ×
 * cancels it. */
export const FileInProgress: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const id = startFileDownload("dataset-2026-11.parquet", 48 * MB);
          reportDownloadBytes(id, 31 * MB);
        }}
      />
    </>
  ),
};

/** Finished: a check and the size; the × only dismisses. */
export const FileDone: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const id = startFileDownload("report.pdf", 820 * 1024);
          reportDownloadBytes(id, 820 * 1024);
          finishDownload(id);
        }}
      />
    </>
  ),
};

/** A folder or multi-select: the file count in the title, the bytes of the
 * whole batch underneath. */
export const BatchInProgress: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const id = startBatchDownload(40, 12 * MB);
          tickBatchDownload(id, 12);
          reportDownloadBytes(id, 4 * MB);
        }}
      />
    </>
  ),
};

export const BatchDone: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const id = startBatchDownload(40, 12 * MB);
          tickBatchDownload(id, 40);
          reportDownloadBytes(id, 12 * MB);
          finishDownload(id);
        }}
      />
    </>
  ),
};

/** Size not known (zero-byte files): bytes only, no percentage. */
export const UnknownSize: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          startBatchDownload(3, 0);
        }}
      />
    </>
  ),
};

/** The file name runs past the card: truncated, full name on hover. */
export const LongFileName: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const id = startFileDownload("a-suspiciously-long-report-filename-nobody-should-actually-use.pdf", 2 * MB);
          reportDownloadBytes(id, MB / 2);
        }}
      />
    </>
  ),
};

/** Several at once: the newest in front, the rest stacked behind it. Point
 * at the stack to fan it out. */
export const Stacked: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed
        seed={() => {
          const done = startFileDownload("report.pdf", 820 * 1024);
          reportDownloadBytes(done, 820 * 1024);
          finishDownload(done);
          const batch = startBatchDownload(40, 12 * MB);
          tickBatchDownload(batch, 12);
          reportDownloadBytes(batch, 4 * MB);
          const file = startFileDownload("dataset-2026-11.parquet", 48 * MB);
          reportDownloadBytes(file, 31 * MB);
        }}
      />
    </>
  ),
};

/** Downloads that actually move: the bar fills, then turns into the done
 * state. Start more from the button to watch the stack grow; cancel one
 * from its ×. */
export const Simulated: Story = {
  render: () => (
    <>
      <DownloadToasts />
      <Seed seed={() => simulateFile("video-capture.mp4", 64 * MB, 2 * MB, 120)} />
      <div className="flex gap-2 p-6">
        <Button variant="outline" size="sm" onClick={() => simulateFile(`file-${String(Date.now() % 1000)}.zip`, 24 * MB, MB, 100)}>
          Start a download
        </Button>
        <Button variant="outline" size="sm" onClick={clearDownloads}>
          Clear
        </Button>
      </div>
    </>
  ),
};
