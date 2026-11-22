import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotTemplatesView } from "@/components/bots/BotTemplatesView";

const meta = {
  title: "Bots/Templates",
  component: BotTemplatesView,
  args: { onPick: () => undefined },
  decorators: [
    (Story) => (
      <div className="h-[860px] w-[1180px] bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotTemplatesView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** What a bot is, and a card per template after "From scratch". */
export const Templates: Story = {};

/** A narrow tab: the cards stack. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="h-[860px] w-[620px] bg-background">
        <Story />
      </div>
    ),
  ],
};
