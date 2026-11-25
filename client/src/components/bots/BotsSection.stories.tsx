import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotsSection } from "@/components/bots/BotsSection";
import { storyBots, storyProfile } from "@/components/bots/botStoryData";
import { setBots } from "@/lib/bots/botsStore";
import type { BotSummary } from "@/lib/bots/botTypes";

const noop = (): void => undefined;

/** The section with the store filled the way the relay's watch would. */
function SectionWithBots({ bots, selectedSession = null, selectedAgentOf = null, onNewBot = noop }: { bots: BotSummary[]; selectedSession?: string | null; selectedAgentOf?: string | null; onNewBot?: (start?: "templates") => void }) {
  setBots(storyProfile.id, bots);
  return (
    <div className="flex h-[480px] w-[280px] flex-col bg-bg-sidebar">
      <BotsSection profile={storyProfile} selectedSession={selectedSession} selectedAgentOf={selectedAgentOf} onSelectBot={noop} onOpenAgent={noop} onNewBot={onNewBot} onBotSettings={noop} onTogglePaused={noop} onDeleteBot={noop} />
    </div>
  );
}

const meta = {
  title: "Bots/Sidebar section",
  component: SectionWithBots,
  args: { bots: storyBots },
} satisfies Meta<typeof SectionWithBots>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One bot per state: needs you, working, scheduled, paused, failed, setting up. */
export const States: Story = {};

/** Nobody has a bot yet. */
export const Empty: Story = { args: { bots: [] } };

/** One of Vigia's agents is the active tab: the bot stays selected with it,
 * its tree open, since the agent is part of the bot's session. */
export const AgentOpen: Story = { args: { selectedSession: "worker-1", selectedAgentOf: "room-vigia" } };
