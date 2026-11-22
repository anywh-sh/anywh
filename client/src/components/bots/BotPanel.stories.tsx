import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotPanelView } from "@/components/bots/BotPanel";
import { storyBotView, storyEmptyBot, storyMemory, storyProfile, storySoul } from "@/components/bots/botStoryData";

const meta = {
  title: "Bots/Panel",
  component: BotPanelView,
  args: { profile: storyProfile, bot: storyBotView, onOpenSession: () => undefined },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[400px] border border-border bg-bg-sidebar">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotPanelView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Tasks by status (what needs the person first), closed ones folded, and the automations. */
export const Tasks: Story = {};

/** A new bot: nothing taken on yet, no automation. */
export const Empty: Story = { args: { bot: storyEmptyBot } };

/** A task with the bot's question, answerable in place. */
export const Question: Story = { args: { initialTask: 13 } };

/** A task at work: what makes it done, its agent, its history. */
export const Working: Story = { args: { initialTask: 12 } };

/** The bot's own conversation is waiting for the person. */
export const ConversationWaits: Story = { args: { bot: { ...storyBotView, conversationNeedsYou: true } } };

/** The gear's settings, in place of the task list: name and face, who it is,
 * memory, pausing or deleting. */
export const Settings: Story = { args: { initialSettings: true, settingsInitial: { soul: storySoul, memory: storyMemory } } };

/** Settings of a bot that remembers nothing yet. */
export const SettingsEmptyMemory: Story = { args: { initialSettings: true, settingsInitial: { soul: storySoul, memory: [] } } };
