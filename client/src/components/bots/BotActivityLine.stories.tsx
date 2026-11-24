import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotActivityLine } from "@/components/bots/BotActivityLine";

const meta = {
  title: "Bots/Activity line",
  component: BotActivityLine,
  args: { activity: { kind: "asked", n: 2, text: "Retry per test or the whole job?" }, onOpenTask: () => undefined },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotActivityLine>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A question to the person: the way to it, with its arrow always on. */
export const Asked: Story = {};

/** Any other line naming a task opens it too; its arrow shows on hover. */
export const Created: Story = { args: { activity: { kind: "created", n: 3, text: "Fix the flaky relay test" } } };

/** A line about something that is not a task stays plain text. */
export const Remembered: Story = { args: { activity: { kind: "remembered", text: "Deploys happen on Fridays" } } };

/** Where nothing can open the panel, a question is plain text too. */
export const AskedWithoutPanel: Story = { args: { onOpenTask: undefined } };
