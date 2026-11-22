import type { Meta, StoryObj } from "@storybook/react-vite";
import { NewBotView } from "@/components/bots/NewBotView";
import { storyBots, storyProfile } from "@/components/bots/botStoryData";
import { setBots } from "@/lib/bots/botsStore";

const meta = {
  title: "Bots/New bot",
  component: NewBotView,
  args: { profile: storyProfile, onCreated: () => undefined, agents: ["claude", "codex"] },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-[1180px] bg-background">
        <Story />
      </div>
    ),
  ],
  // A profile that has bots already goes straight to the templates.
  beforeEach: () => {
    setBots(storyProfile.id, storyBots);
    return () => setBots(storyProfile.id, []);
  },
} satisfies Meta<typeof NewBotView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Step one, in its own tab: the person's own words, or a template with its preview. */
export const Templates: Story = {};

/** A profile with no bot yet: a presentation first. */
export const FirstBot: Story = {
  beforeEach: () => {
    setBots(storyProfile.id, []);
  },
};

/** A narrow tab: the preview column folds to a bar holding the step's action. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="h-[760px] w-[520px] bg-background">
        <Story />
      </div>
    ),
  ],
};
