import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotsRelayGateView } from "@/components/bots/BotsRelayGate";
import { MANUAL_UPGRADE_COMMAND } from "@/hooks/relay/useLegacyRelayUpgrade";

const noop = (): void => undefined;

const meta = {
  title: "Bots/Relay too old",
  component: BotsRelayGateView,
  args: { relayVersion: "0.2.40", state: { phase: "hidden" }, onUpdate: noop },
  decorators: [
    (Story) => (
      <div className="w-[280px] bg-bg-sidebar">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotsRelayGateView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The app cannot offer the update (the relay did not say its version): the command. */
export const OtherMachine: Story = {};

/** A relay that does not say its version (a build from source). */
export const VersionUnknown: Story = { args: { relayVersion: undefined } };

/** An older relay the app can update: the one button. */
export const UpdateOffered: Story = { args: { state: { phase: "available" } } };

/** A reply is still running on that relay: the update waits for it. */
export const Waiting: Story = { args: { state: { phase: "waiting", busy: 1 } } };

/** It could not run there: why, and the command for the relay's machine. */
export const Failed: Story = {
  args: { state: { phase: "failed", reason: "installer", detail: "checksum mismatch for anywh-relay-0.2.50-linux-x64.tar.gz", command: MANUAL_UPGRADE_COMMAND } },
};
