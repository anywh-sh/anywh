import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotsRelayGate } from "@/components/bots/BotsRelayGate";
import { storyProfile } from "@/components/bots/botStoryData";

const meta = {
  title: "Bots/Relay too old",
  component: BotsRelayGate,
  args: { profile: storyProfile, relayVersion: "0.2.40" },
  decorators: [
    (Story) => (
      <div className="w-[280px] bg-bg-sidebar">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotsRelayGate>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A relay on another machine: the command to run there. */
export const OtherMachine: Story = {};

/** A relay that does not say its version (a build from source). */
export const VersionUnknown: Story = { args: { relayVersion: undefined } };
