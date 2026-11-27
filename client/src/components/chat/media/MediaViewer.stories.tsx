import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
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

/** A sent recording: the strip shows its extracted frame, badged as a video. */
const RECORDING: ChatMediaItem = { path: "/tmp/sim/checkout.mov", kind: "video", poster: "/tmp/sim/checkout-frame.jpg", alt: "Checkout flow" };

interface HarnessProps {
  items: ChatMediaItem[];
  start?: number;
  /** Never answers: the viewer stays loading. */
  pending?: boolean;
}

/** The viewer with the state its owner keeps (which file, open or not).
 * Closing it plays the way out, and the button opens it again — which is
 * how to watch it come and go. */
function Harness({ items, start = 0, pending = false }: HarnessProps) {
  const [index, setIndex] = useState(start);
  const [open, setOpen] = useState(true);
  const source = useMemo(() => (pending ? pendingMediaSource : simulatedMediaSource(SAMPLE_FILES)), [pending]);
  return (
    <>
      <Button variant="outline" className="m-4" onClick={() => setOpen(true)}>
        Open the viewer
      </Button>
      <MediaViewer items={items} index={index} source={source} open={open} onIndexChange={setIndex} onClose={() => setOpen(false)} onDownload={() => {}} />
    </>
  );
}

const meta = {
  title: "Chat/Media/Viewer",
  component: Harness,
  parameters: { layout: "fullscreen" },
  // The app provides this at its root; the header's controls have tooltips.
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One file: its caption as the title, no counter, arrows or strip. The
 * magnifier (or a click on the picture) shows it at its own pixels. */
export const Image: Story = {
  args: { items: [SCREENS[0]] },
};

/** Several: the counter, an arrow in a gutter on each side (and ← →, or a
 * swipe), and a strip of thumbnails to jump with — a recording among them. */
export const Gallery: Story = {
  args: { items: [...SCREENS, RECORDING], start: 1 },
};

/** A wide picture fits the width instead of the height. */
export const Wide: Story = {
  args: { items: [SCREENS[4]] },
};

/** The relay no longer has the file: says so, with the path, and offers
 * nothing to zoom into or download. */
export const Failed: Story = {
  args: { items: [{ path: "/tmp/sim/gone.png", kind: "image", alt: "First attempt" }] },
};

/** Still on its way. */
export const Loading: Story = {
  args: { items: SCREENS.slice(0, 2), pending: true },
};
