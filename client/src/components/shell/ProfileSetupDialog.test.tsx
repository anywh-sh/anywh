import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles";
import type { SetupState } from "@/lib/profileSetup";
import { ProfileSetupDialog } from "./ProfileSetupDialog";
import { en } from "@/i18n/en";

const profile: Profile = {
  id: "new-profile",
  label: "New machine",
  host: "127.0.0.1",
  relayPort: 0,
  brokerNodeId: "node-1",
  brokerUrl: "https://broker.test/w1",
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://ctrl.test",
};

const existingProfile: Profile = { id: "existing", label: "Existing machine", host: "1.2.3.4", relayPort: 8443 };

function noop() {}

afterEach(() => {
  cleanup();
});

describe("ProfileSetupDialog", () => {
  it("renders nothing when there is no state", () => {
    render(
      <ProfileSetupDialog state={null} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the tailnet claim step as running while claiming", () => {
    const state: SetupState = { status: "claiming", mode: "tailnet" };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByText(en.shell.profiles.setup.connectingTitle)).toBeInTheDocument();
    expect(screen.getByText(en.shell.profiles.setup.steps.claim)).toBeInTheDocument();
    // Not yet failed or done — no action button beyond the always-present dismiss.
    expect(screen.queryByRole("button", { name: en.common.retry })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shell.profiles.setup.continueToProfile })).not.toBeInTheDocument();
  });

  it("shows the direct-mode step list with just one row", () => {
    const state: SetupState = { status: "connecting", mode: "direct", profile: { ...profile, id: "direct-profile" } };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByText(en.shell.profiles.setup.steps.verify)).toBeInTheDocument();
    expect(screen.queryByText(en.shell.profiles.setup.steps.claim)).not.toBeInTheDocument();
    expect(screen.queryByText(en.shell.profiles.setup.steps.connect)).not.toBeInTheDocument();
  });

  it("on ready, shows the session count and a working Continuar button", async () => {
    const onContinue = vi.fn();
    const state: SetupState = { status: "ready", mode: "tailnet", profile, info: { sessionCount: 3 }, duplicates: [] };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={onContinue} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );

    expect(screen.getByText(en.shell.profiles.setup.connectedTitle)).toBeInTheDocument();
    expect(screen.getByText(en.shell.profiles.setup.ready.replace("{count}", "3"))).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));
    expect(onContinue).toHaveBeenCalledWith(profile.id);
  });

  it("on ready with a duplicate, offers to go to the existing profile", async () => {
    const onUseExisting = vi.fn();
    const state: SetupState = {
      status: "ready",
      mode: "tailnet",
      profile,
      info: { sessionCount: 0 },
      duplicates: [existingProfile],
    };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={onUseExisting} onRetry={noop} onDismiss={noop} />,
    );

    expect(screen.getByText(existingProfile.label, { exact: false })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.useExisting }));
    expect(onUseExisting).toHaveBeenCalledWith(existingProfile.id);
  });

  it("on a terminal claim failure, offers only dismiss — nothing to retry", () => {
    const state: SetupState = { status: "failed", mode: "tailnet", stage: "claim" };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );

    expect(screen.getByText(en.shell.profiles.setup.claimFailedTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.common.retry })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.shell.profiles.setup.later })).toBeInTheDocument();
  });

  it("on a recoverable connect failure, retrying calls onRetry", async () => {
    const onRetry = vi.fn();
    const state: SetupState = { status: "failed", mode: "tailnet", stage: "connect", profile };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={onRetry} onDismiss={noop} />,
    );

    expect(screen.getByText(en.shell.profiles.setup.connectFailedTitle)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.common.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("dismisses via the dedicated button", async () => {
    const onDismiss = vi.fn();
    const state: SetupState = { status: "claiming", mode: "direct" };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={onDismiss} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape once there's an outcome to leave", async () => {
    const onDismiss = vi.fn();
    const state: SetupState = { status: "failed", mode: "direct", stage: "claim" };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={onDismiss} />,
    );

    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "claiming", mode: "direct" },
    { status: "connecting", mode: "direct", profile },
    { status: "verifying", mode: "direct", profile },
  ] satisfies SetupState[])("blocks Escape and the header's close button while $status, so an accidental one can't lose the reader's place", (state) => {
    const onDismiss = vi.fn();
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={onDismiss} />,
    );

    // The header's close (X) button isn't rendered at all mid-flight — the
    // dedicated "Deixar para depois" button is the only way out.
    expect(screen.queryByRole("button", { name: en.common.close })).not.toBeInTheDocument();
  });

  it("won't dismiss on Escape while still claiming, but the dedicated button still works", async () => {
    const onDismiss = vi.fn();
    const state: SetupState = { status: "claiming", mode: "direct" };
    render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={onDismiss} />,
    );

    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(onDismiss).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides 'Deixar para depois' on ready when hideLaterWhenReady is set, unlike the shell's default", () => {
    const state: SetupState = { status: "ready", mode: "tailnet", profile, info: { sessionCount: 0 }, duplicates: [] };
    const { rerender } = render(
      <ProfileSetupDialog state={state} queuedCount={0} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByRole("button", { name: en.shell.profiles.setup.later })).toBeInTheDocument();

    rerender(
      <ProfileSetupDialog
        state={state}
        queuedCount={0}
        onContinue={noop}
        onUseExisting={noop}
        onRetry={noop}
        onDismiss={noop}
        hideLaterWhenReady
      />,
    );
    expect(screen.queryByRole("button", { name: en.shell.profiles.setup.later })).not.toBeInTheDocument();
  });

  it("shows the queued count in the footer", () => {
    const state: SetupState = { status: "claiming", mode: "tailnet" };
    render(
      <ProfileSetupDialog state={state} queuedCount={2} onContinue={noop} onUseExisting={noop} onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByText(en.shell.profiles.setup.queued.replace("{count}", "2"))).toBeInTheDocument();
  });
});
