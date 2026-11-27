import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatMediaItem } from "@/lib/media/chatMedia";
import { MediaViewer } from "@/components/chat/media/MediaViewer";
import { pendingMediaSource, SAMPLE_FILES, simulatedMediaSource } from "@/components/chat/media/sampleMedia";

const SCREENS: ChatMediaItem[] = [
  { path: "/tmp/sim/01-sign-in.png", kind: "image", alt: "Sign in" },
  { path: "/tmp/sim/02-home.png", kind: "image", alt: "Home" },
  { path: "/tmp/sim/03-settings.png", kind: "image" },
  { path: "/tmp/sim/04-error.png", kind: "image", alt: "Error after submitting the form" },
  { path: "/tmp/sim/usage-chart.png", kind: "image", alt: "Requests per day" },
];

interface HarnessProps {
  items: ChatMediaItem[];
  start?: number;
  /** Never answers: the viewer stays loading. */
  pending?: boolean;
}

/** The viewer with the state its owner keeps (which file, open or not);
 * closing it leaves a button to open it again. */
function Harness({ items, start = 0, pending = false }: HarnessProps) {
  const [index, setIndex] = useState(start);
  const [open, setOpen] = useState(true);
  const source = useMemo(() => (pending ? pendingMediaSource : simulatedMediaSource(SAMPLE_FILES)), [pending]);
  if (!open) return <Button onClick={() => setOpen(true)}>Open the viewer</Button>;
  return <MediaViewer items={items} index={index} source={source} onIndexChange={setIndex} onClose={() => setOpen(false)} onDownload={() => {}} />;
}

const meta = {
  title: "Chat/Media/Viewer",
  component: Harness,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One file: its caption, no counter, arrows or strip. The magnifier (or a
 * click on the picture) shows it at its own pixels. */
export const Image: Story = {
  args: { items: [SCREENS[0]] },
};

/** Several: counter, arrows (and ← →, or a swipe), and a strip of
 * thumbnails to jump with. */
export const Gallery: Story = {
  args: { items: SCREENS, start: 1 },
};

/** A wide picture fits the width instead of the height. */
export const Wide: Story = {
  args: { items: [SCREENS[4]] },
};

/** The relay no longer has the file: says so, with the path. */
export const Failed: Story = {
  args: { items: [{ path: "/tmp/sim/gone.png", kind: "image", alt: "First attempt" }] },
};

/** Still on its way. */
export const Loading: Story = {
  args: { items: SCREENS.slice(0, 2), pending: true },
};
