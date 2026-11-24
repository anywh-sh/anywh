import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotActivityLine } from "@/components/bots/BotActivityLine";
import { BotNote } from "@/components/bots/BotNote";
import type { BotActivity } from "@/lib/bots/botActivity";

const NOTES: { schedule: boolean; label: string }[] = [
  { schedule: true, label: "CI check" },
  { schedule: false, label: "created" },
  { schedule: false, label: "answer:13" },
  { schedule: false, label: "cancel:8" },
  { schedule: false, label: "peer_ask:Release" },
  { schedule: false, label: "peer_answer:Release" },
  { schedule: false, label: "peer_noanswer:Release" },
  { schedule: false, label: "peer_handoff:15:Release" },
  { schedule: false, label: "peer_closed:4:Fixer bot" },
];

const PEER_ACTIVITY: BotActivity[] = [
  { kind: "peers" },
  { kind: "askedBot", name: "Release", text: "What shipped yesterday?" },
  { kind: "handedOff", name: "Fixer bot", text: "Fix the flaky wakeup test" },
];

const meta = {
  title: "Bots/Conversation notes",
  component: BotNote,
  args: { schedule: false, label: "created" },
  decorators: [
    (Story) => (
      <div className="w-[520px] bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotNote>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Where each relay turn starts in a bot's conversation, the other bots' messages included. */
export const Notes: Story = {
  render: () => (
    <div className="flex flex-col gap-3" data-testid="bot-notes">
      {NOTES.map((note) => (
        <BotNote key={note.label} {...note} />
      ))}
    </div>
  ),
};

/** The lines a bot's calls to other bots leave in its conversation. */
export const PeerActivity: Story = {
  render: () => (
    <div className="flex flex-col gap-2" data-testid="bot-peer-activity">
      {PEER_ACTIVITY.map((activity) => (
        <BotActivityLine key={activity.kind} activity={activity} />
      ))}
    </div>
  ),
};
