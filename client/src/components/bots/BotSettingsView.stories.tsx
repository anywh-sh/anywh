import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotSettingsView } from "@/components/bots/BotSettingsView";
import { storyBotView, storyProfile } from "@/components/bots/botStoryData";
import type { MemoryLine } from "@/lib/bots/botTypes";

const memory: MemoryLine[] = [
  { index: 0, kind: "rule", text: "Never merge: pull requests stay drafts.", source: "conversation", date: "2026-11-18", raw: "- [rule] Never merge" },
  { index: 1, kind: "preference", text: "Retry a test at most twice.", source: "task #13", date: "2026-11-20", raw: "- [preference] Retry" },
  { index: 2, kind: "fact", text: "e2e-relay runs against the local relay, not staging.", source: "task #12", date: "2026-11-21", raw: "- [fact] e2e-relay" },
];

const soul = "I watch the CI of the main branch and tell a flaky test from a real failure.\n\n## How I work\n- I check recent runs with gh.\n\n## Never\n- Merge anything.";

const meta = {
  title: "Bots/Settings",
  component: BotSettingsView,
  args: { profile: storyProfile, botId: storyBotView.id, onDeleted: () => undefined, onRenamed: () => undefined, initial: { bot: storyBotView, soul, memory } },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[1100px] bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotSettingsView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Who it is: its name and soul. */
export const WhoItIs: Story = {};

/** A bot with nothing remembered yet. */
export const EmptyMemory: Story = { args: { initial: { bot: storyBotView, soul, memory: [] } } };
