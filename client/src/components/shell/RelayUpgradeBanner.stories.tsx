import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { RelayUpgradeNotice } from "@/components/shell/RelayUpgradeBanner";
import type { LegacyUpgradeState } from "@/hooks/relay/useLegacyRelayUpgrade";
import { MANUAL_UPGRADE_COMMAND } from "@/hooks/relay/useLegacyRelayUpgrade";

const noop = (): void => undefined;

const meta = {
  title: "Shell/Relay update notice",
  component: RelayUpgradeNotice,
  args: { profileLabel: "Home server", state: { phase: "available" }, onUpdate: noop, onDismiss: noop },
  decorators: [
    (Story) => (
      <div className="w-[720px] bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RelayUpgradeNotice>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An older relay that cannot update itself: one button. */
export const Available: Story = {};

export const Checking: Story = { args: { state: { phase: "checking" } } };

/** A reply is still running: the update waits for it on its own. */
export const WaitingForOne: Story = { args: { state: { phase: "waiting", busy: 1 } } };

export const WaitingForSeveral: Story = { args: { state: { phase: "waiting", busy: 3 } } };

export const Updating: Story = { args: { state: { phase: "updating" } } };

export const Restarting: Story = { args: { state: { phase: "restarting" } } };

export const Done: Story = { args: { state: { phase: "done" } } };

/** The app could not run it there (no terminal on that machine): the command. */
export const Failed: Story = {
  args: { state: { phase: "failed", error: "the relay's terminal closed before the update ran", command: MANUAL_UPGRADE_COMMAND } },
};

export const FailedWithoutReason: Story = { args: { state: { phase: "failed", error: null, command: MANUAL_UPGRADE_COMMAND } } };

const SIMULATED: readonly LegacyUpgradeState[] = [
  { phase: "checking" },
  { phase: "waiting", busy: 1 },
  { phase: "updating" },
  { phase: "restarting" },
  { phase: "done" },
];

function SimulatedNotice() {
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (step < 0 || step >= SIMULATED.length - 1) return;
    const timer = setTimeout(() => setStep((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [step]);
  const state: LegacyUpgradeState = step < 0 ? { phase: "available" } : SIMULATED[step];
  return <RelayUpgradeNotice profileLabel="Home server" state={state} onUpdate={() => setStep(0)} onDismiss={() => setStep(-1)} />;
}

/** Click Update to walk through the whole flow. */
export const Simulated: Story = { render: () => <SimulatedNotice /> };
