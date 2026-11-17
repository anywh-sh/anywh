import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "./button";
import { Toaster } from "./sonner";

/** Fires the given toasts once the story mounts and clears them when it
 * unmounts — sonner's queue is global, so a story left running would leak
 * its toasts into the next one. */
function Fire({ fire }: { fire: () => void }) {
  useEffect(() => {
    fire();
    return () => {
      toast.dismiss();
    };
  }, [fire]);
  return null;
}

const meta = {
  title: "Primitives/Toaster",
  component: Toaster,
  excludeStories: /^[a-z]/,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-screen bg-background">
        <Story />
      </div>
    ),
  ],
  args: { position: "bottom-right", duration: Infinity },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One plain toast, in the app's theme tokens. */
export const Default: Story = {
  render: (args) => (
    <>
      <Toaster {...args} />
      <Fire fire={() => toast("Settings saved")} />
    </>
  ),
};

/** Each built-in type, piled up: only the newest is in front; point at the
 * stack to fan it out. sonner shows at most three at a time (its
 * `visibleToasts` default) — the older two wait until one is dismissed. */
export const Types: Story = {
  render: (args) => (
    <>
      <Toaster {...args} />
      <Fire
        fire={() => {
          toast.info("A new version is available");
          toast.warning("The relay is slow to answer");
          toast.error("Could not rename the file");
          toast.success("Profile created");
          toast.loading("Connecting to the relay…");
        }}
      />
    </>
  ),
};

/** Toasts from a button, to watch the stack grow and the enter animation. */
export const Playground: Story = {
  render: (args) => (
    <>
      <Toaster {...args} />
      <div className="flex gap-2 p-6">
        <Button variant="outline" size="sm" onClick={() => toast(`Toast at ${new Date().toLocaleTimeString()}`)}>
          Add toast
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast.dismiss()}>
          Clear
        </Button>
      </div>
    </>
  ),
};
