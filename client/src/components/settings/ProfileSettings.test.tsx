import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { InstallDoneEvent, LocalRelayProbe } from "@/lib/localRelay";
import type { Profile } from "@/lib/profiles";

function probe(overrides: Partial<LocalRelayProbe> = {}): LocalRelayProbe {
  return {
    platform: "linux",
    supported: true,
    containerized: null,
    installDir: "/home/user/.local/share/anywh",
    installed: true,
    installedVersion: "0.1.0",
    unitInstalled: true,
    envDir: "/home/user/.config/anywh/env",
    profiles: [],
    orphanDefault: false,
    previousRun: null,
    ...overrides,
  };
}

const { localInstallPossibleMock, probeLocalRelayMock, startLocalInstallMock, onInstallDoneMock, currentPlatformMock } = vi.hoisted(() => ({
  localInstallPossibleMock: vi.fn(() => true),
  probeLocalRelayMock: vi.fn(async (): Promise<LocalRelayProbe | null> => probe()),
  startLocalInstallMock: vi.fn(async () => ({ runId: "r1", logPath: "/tmp/r1.log", started: true })),
  onInstallDoneMock: vi.fn(async (_handler: (event: InstallDoneEvent) => void) => () => {}),
  currentPlatformMock: vi.fn(() => "linux"),
}));

vi.mock("@/lib/localRelay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/localRelay")>();
  return {
    ...actual,
    localInstallPossible: localInstallPossibleMock,
    probeLocalRelay: probeLocalRelayMock,
    startLocalInstall: startLocalInstallMock,
    onInstallDone: onInstallDoneMock,
  };
});
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, currentPlatform: currentPlatformMock };
});

import { ProfileSettings } from "@/components/settings/ProfileSettings";

const copy = en.settings.profile.relay;

const localProfile: Profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
const remoteProfile: Profile = { id: "remote", label: "Remote", host: "100.64.0.1", relayPort: 8765 };

function renderProfile(profile: Profile) {
  return render(
    <ProfileSettings profile={profile} allProfiles={[profile]} effectiveColorIndex={0} onProfileRemoved={() => {}} />,
  );
}

afterEach(() => {
  cleanup();
  localInstallPossibleMock.mockReset().mockReturnValue(true);
  probeLocalRelayMock.mockReset().mockResolvedValue(probe());
  startLocalInstallMock.mockClear();
  onInstallDoneMock.mockReset().mockResolvedValue(() => {});
  currentPlatformMock.mockReset().mockReturnValue("linux");
});

describe("ProfileSettings: local relay drift", () => {
  it("says nothing for a profile whose relay isn't on this machine", async () => {
    renderProfile(remoteProfile);
    // Give the (never-called, since this profile isn't loopback) probe a
    // tick to prove its absence isn't just a timing accident.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
  });

  it("says nothing when the local relay is already current", async () => {
    probeLocalRelayMock.mockResolvedValue(probe({ installedVersion: "999.0.0" }));
    renderProfile(localProfile);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
  });

  it("offers to update an out-of-date local relay on Linux", async () => {
    renderProfile(localProfile);
    expect(await screen.findByText(copy.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.update })).toBeInTheDocument();
  });

  it("re-runs the installer against this same profile's host, and reports success", async () => {
    let doneHandler: ((event: InstallDoneEvent) => void) | undefined;
    onInstallDoneMock.mockImplementation(async (handler: (event: InstallDoneEvent) => void) => {
      doneHandler = handler;
      return () => {};
    });
    renderProfile(localProfile);
    const button = await screen.findByRole("button", { name: copy.update });
    const user = userEvent.setup();

    await user.click(button);

    expect(startLocalInstallMock).toHaveBeenCalledWith({
      profileId: "default",
      relayHost: "127.0.0.1",
      profileHome: undefined,
      mode: "prod",
    });
    expect(await screen.findByText(copy.updating)).toBeInTheDocument();

    doneHandler?.({ runId: "r1", exitCode: 0, ok: true, profile: null, failure: null });
    expect(await screen.findByText(copy.updated)).toBeInTheDocument();
  });

  it("shows the brew command instead of a button on macOS, never calling the in-app installer", async () => {
    currentPlatformMock.mockReturnValue("macos");
    renderProfile(localProfile);

    expect(await screen.findByText(copy.brewHint)).toBeInTheDocument();
    expect(screen.getByText("brew upgrade anywh-relay")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.update })).not.toBeInTheDocument();
  });
});
