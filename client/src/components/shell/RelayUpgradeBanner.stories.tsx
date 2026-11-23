import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { RelayUpgradeNotice } from "@/components/shell/RelayUpgradeBanner";
import type { LegacyUpgradeState } from "@/hooks/relay/useLegacyRelayUpgrade";
import { MANUAL_BREW_COMMAND, MANUAL_UPGRADE_COMMAND } from "@/hooks/relay/useLegacyRelayUpgrade";

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

/** A Homebrew relay on this Mac: offered with every release, so no promise
 * that it keeps itself up to date. */
export const AvailableEachTime: Story = { args: { eachTime: true } };

export const Checking: Story = { args: { state: { phase: "checking" } } };

/** A reply is still running: the update waits for it on its own. */
export const WaitingForOne: Story = { args: { state: { phase: "waiting", busy: 1 } } };

export const WaitingForSeveral: Story = { args: { state: { phase: "waiting", busy: 3 } } };

export const Updating: Story = { args: { state: { phase: "updating" } } };

export const Restarting: Story = { args: { state: { phase: "restarting" } } };

export const Done: Story = { args: { state: { phase: "done" } } };

/** The app could not run it there (no terminal on that machine): the command. */
export const Failed: Story = { args: { state: { phase: "failed", reason: "terminal", command: MANUAL_UPGRADE_COMMAND } } };

/** The installer stopped: its own words under the reason. */
export const InstallerFailed: Story = {
  args: { state: { phase: "failed", reason: "installer", detail: "checksum mismatch for anywh-relay-0.2.50-linux-x64.tar.gz", command: MANUAL_UPGRADE_COMMAND } },
};

/** The app ran Homebrew on this Mac and it failed: Homebrew's own words. */
export const HomebrewFailed: Story = {
  args: { eachTime: true, state: { phase: "failed", reason: "homebrew", detail: "Error: anywh-relay: SHA256 mismatch", command: MANUAL_BREW_COMMAND } },
};

/** Homebrew ran past the app's limit and was stopped. */
export const HomebrewTimedOut: Story = { args: { eachTime: true, state: { phase: "failed", reason: "timed_out", command: MANUAL_BREW_COMMAND } } };

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
