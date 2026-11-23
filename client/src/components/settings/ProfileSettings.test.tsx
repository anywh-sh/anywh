import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLegacyRelayUpgrades } from "@/hooks/relay/useLegacyRelayUpgrade";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";

// The update is offered against a released app: git keeps APP_VERSION at the
// unreleased placeholder, and only the release build stamps a real one. This
// is the app as a release build sees itself.
vi.mock("@/lib/install/appVersion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/install/appVersion")>();
  return { ...actual, APP_VERSION: "0.2.0" };
});

import { ProfileSettings } from "@/components/settings/ProfileSettings";

const copy = en.settings.profile.relay;
const upgrade = en.shell.relayUpgrade;

const localProfile: Profile = { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 };
const remoteProfile: Profile = { id: "remote", label: "Remote", host: "100.64.0.1", relayPort: 8765 };

function renderProfile(profile: Profile) {
  return render(<ProfileSettings profile={profile} allProfiles={[profile]} effectiveColorIndex={0} onProfileRemoved={() => {}} />);
}

/** The relay is the network edge: `GET /host-info` answers as `info`,
 * `GET /sessions` with no conversations, anything else is refused. */
function relayAnswers(info: { version?: string; features?: string[] }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === "/host-info") return Promise.resolve(new Response(JSON.stringify({ hostname: "h", platform: "linux", editor: null, ...info })));
      if (path === "/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [] })));
      return Promise.reject(new TypeError("Failed to fetch"));
    }),
  );
}

beforeEach(() => {
  resetLegacyRelayUpgrades();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("ProfileSettings: relay too old to update itself", () => {
  it("says nothing for a relay that updates itself", async () => {
    relayAnswers({ version: "0.1.0", features: ["bots", "self_update"] });
    renderProfile(localProfile);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
  });

  it("says nothing when the relay is already on the app's version", async () => {
    relayAnswers({ version: "0.2.0", features: ["bots"] });
    renderProfile(localProfile);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
  });

  it("offers the update for an older relay, on this machine or another one", async () => {
    relayAnswers({ version: "0.1.0", features: ["bots"] });
    renderProfile(remoteProfile);
    expect(await screen.findByText(copy.description.replace("{relayVersion}", "0.1.0").replace("{appVersion}", "0.2.0"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: upgrade.update })).toBeInTheDocument();
  });

  it("pressing it checks for conversations first, and says so when the relay's machine cannot be reached, with the command to run there", async () => {
    relayAnswers({ version: "0.1.0", features: ["bots"] });
    renderProfile(localProfile);
    await userEvent.setup().click(await screen.findByRole("button", { name: upgrade.update }));
    // No terminal can be opened here (no relay behind the WebSocket).
    expect(await screen.findByText(upgrade.failedReasons.terminal, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(upgrade.runThere)).toBeInTheDocument();
  });
});
