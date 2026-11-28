import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo } from "react";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { AssistantText } from "@/components/chat/Message";
import { ChatMediaProvider } from "@/components/chat/media/ChatMediaProvider";
import { MediaTile } from "@/components/chat/media/MediaTile";
import { SAMPLE_FILES, simulatedMediaSource } from "@/components/chat/media/sampleMedia";
import { TooltipProvider } from "@/components/ui/tooltip";

interface ReplyProps {
  /** The agent's reply, as Markdown. */
  text: string;
  /** Pictures fetched (a tailnet profile) instead of loaded from a URL. */
  fetched?: boolean;
  /** How long a fetched picture takes to arrive. */
  delayMs?: number;
}

/** An agent's reply as the chat renders it, against a stand-in relay that
 * serves `SAMPLE_FILES` (any other path is a file it no longer has). */
function Reply({ text, fetched = false, delayMs = 0 }: ReplyProps) {
  const source = useMemo(() => simulatedMediaSource(SAMPLE_FILES, { direct: !fetched, delayMs }), [fetched, delayMs]);
  return (
    <ChatMediaProvider source={source} onDownload={() => {}}>
      <div data-media-scope="" className="prose-chat max-w-2xl min-w-0 text-sm text-foreground">
        <MarkdownContent text={text} />
      </div>
    </ChatMediaProvider>
  );
}

const meta = {
  title: "Chat/Media",
  component: Reply,
  parameters: { layout: "padded" },
  // The app provides this at its root; the viewer's controls have tooltips.
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Reply>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One capture alone is drawn large, at its own proportion. */
export const One: Story = {
  args: { text: "The sign-in screen after the fix:\n\n![Sign in](/tmp/sim/01-sign-in.png)" },
};

/** Images on consecutive lines are one gallery: a row of tiles at one
 * height, the line of text before them still a paragraph. */
export const Several: Story = {
  args: {
    text:
      "All four screens of the flow:\n" +
      "![Sign in](/tmp/sim/01-sign-in.png)\n" +
      "![Home](/tmp/sim/02-home.png)\n" +
      "![Settings](/tmp/sim/03-settings.png)\n" +
      "![Error](/tmp/sim/04-error.png)",
  },
};

/** A portrait capture and a wide chart side by side, neither cropped. */
export const MixedShapes: Story = {
  args: {
    text: "Home, and the usage it reports:\n\n![Home](/tmp/sim/02-home.png)\n\n![Requests per day](/tmp/sim/usage-chart.png)",
  },
};

/** Text between images splits them into separate galleries; clicking any
 * tile still walks every image of the reply in the viewer. */
export const Interleaved: Story = {
  args: {
    text:
      "Before the change the error state looked like this:\n\n![Error](/tmp/sim/04-error.png)\n\n" +
      "After it, the same request lands on the home screen:\n\n![Home](/tmp/sim/02-home.png)",
  },
};

/** A path written as code opens the viewer too, alongside the reply's
 * embedded images — on iOS as well, where there is no file panel. */
export const InlinePath: Story = {
  args: { text: "Saved the capture to `/tmp/sim/03-settings.png`, and here is the error state:\n\n![Error](/tmp/sim/04-error.png)" },
};

/** A file the relay no longer serves (moved, deleted, a temp dir wiped):
 * a one-line chip with its name instead of a broken picture. */
export const Unavailable: Story = {
  args: { text: "From yesterday's run:\n\n![Old capture](/tmp/sim/gone.png)" },
};

/** A remote image is a link to it, never loaded on its own: an image
 * request is how an injected prompt would carry data out. */
export const RemoteImage: Story = {
  args: { text: "Build status: ![build passing](https://img.shields.io/badge/build-passing-green)" },
};

/** Fetched pictures (a tailnet profile) hold their place while on the way. */
export const Waiting: Story = {
  args: { ...Several.args, fetched: true, delayMs: 1500 },
};

/** A sent video comes back from history as its first extracted frame, with
 * the play badge — what the bubble shows for an attachment. */
export const SentVideo: Story = {
  args: { text: "" },
  render: () => {
    const source = simulatedMediaSource(SAMPLE_FILES);
    return (
      <ChatMediaProvider source={source}>
        <div data-media-scope="" className="flex gap-1.5">
          <MediaTile item={{ path: "/tmp/anywh-uploads/checkout.mov", kind: "video", poster: "/tmp/sim/checkout-frame.jpg" }} layout="grid" />
          <MediaTile item={{ path: "/tmp/sim/01-sign-in.png", kind: "image" }} layout="grid" />
        </div>
      </ChatMediaProvider>
    );
  },
};

/** A reply that only names the files it made, as an agent often does after
 * writing several: the chat previews them under it once the reply is whole.
 * A name the relay has no file for (`gone.png`) drops out quietly. */
export const MentionedFiles: Story = {
  args: { text: "" },
  render: () => {
    const source = simulatedMediaSource(SAMPLE_FILES);
    return (
      <ChatMediaProvider source={source}>
        <div className="max-w-2xl">
          <AssistantText
            text={"Saved the screens of the flow:\n\n- `/tmp/sim/02-home.png`\n- `/tmp/sim/03-settings.png`\n- `/tmp/sim/gone.png`"}
            streaming={false}
            onCopy={() => {}}
          />
        </div>
      </ChatMediaProvider>
    );
  },
};

/** Everything at once against a relay that takes its time: a reply with a
 * gallery, an inline path and a file that's gone. Click a tile to open the
 * viewer and step through all of them. */
export const Simulated: Story = {
  args: {
    fetched: true,
    delayMs: 600,
    text:
      "I ran the flow on the simulator. The four screens:\n" +
      "![Sign in](/tmp/sim/01-sign-in.png)\n" +
      "![Home](/tmp/sim/02-home.png)\n" +
      "![Settings](/tmp/sim/03-settings.png)\n" +
      "![Error](/tmp/sim/04-error.png)\n\n" +
      "Usage over the week, from `/tmp/sim/usage-chart.png`:\n\n" +
      "![Requests per day](/tmp/sim/usage-chart.png)\n\n" +
      "The capture from the first attempt is gone: ![First attempt](/tmp/sim/first-attempt.png)",
  },
};
