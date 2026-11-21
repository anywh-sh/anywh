import type { Meta, StoryObj } from "@storybook/react-vite";
import { NewBotDialog } from "@/components/bots/NewBotDialog";
import { storyProfile } from "@/components/bots/botStoryData";

const meta = {
  title: "Bots/New bot",
  component: NewBotDialog,
  args: { profile: storyProfile, open: true, onOpenChange: () => undefined, onCreated: () => undefined, agents: ["claude", "codex"] },
} satisfies Meta<typeof NewBotDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Step one: the person's own words, or a template with its preview. */
export const Templates: Story = {};
