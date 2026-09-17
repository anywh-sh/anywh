import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Profile } from "@/lib/profiles/profiles";
import type { Theme } from "@/lib/theme/theme";

vi.mock("@/lib/relay/relayClient", () => ({
  fetchThemes: vi.fn(),
  updateProfileMeta: vi.fn(),
  deleteTheme: vi.fn(),
  saveTheme: vi.fn(),
  ThemeSaveError: class ThemeSaveError extends Error {},
}));
vi.mock("@/lib/profiles/connectionResolver", () => ({
  resolveConnection: vi.fn(),
  authHeaders: () => ({}),
}));

import { fetchThemes, updateProfileMeta, deleteTheme } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { getSelectedThemeId, setSelectedThemeId } from "@/lib/theme/themes";
import { en } from "@/i18n/en";
import { ThemeSection } from "./ThemeSection";

/** The per-card actions live behind one menu, so every test that reaches
 * them opens that card's menu first. */
async function openCardMenu(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: en.settings.appearance.theme.options.replace("{name}", name) }));
}

const CUSTOM_THEME: Theme = {
  version: 1,
  id: "custom-b",
  name: "Custom B",
  appearance: "dark",
  colors: {
    background: "#000000",
    foreground: "#ffffff",
    "muted-foreground": "#888888",
    primary: "#ff0000",
    destructive: "#ff0000",
    border: "#333333",
  },
};

function tailnetProfile(id: string, label: string): Profile {
  return {
    id,
    label,
    // Every tailnet profile reports this same placeholder — the real
    // address only exists after `resolveConnection` resolves the sidecar
    // (see connectionResolver.ts).
    host: "127.0.0.1",
    relayPort: 0,
    tailnetAuthKey: "key",
    tailnetControlUrl: "https://headscale.test",
    tailnetTarget: "100.64.0.1:8443",
  };
}

// Two different tailnet profiles, each its own sandbox — distinct resolved
// connections prove which one a call actually went to. Only the connected
// one is a registry this section can write.
const activeProfile = tailnetProfile("sandbox-a", "A");
const otherProfile = tailnetProfile("sandbox-b", "B");

const CONNECTIONS: Record<string, { host: string; port: number; token: string }> = {
  "sandbox-a": { host: "127.0.0.1", port: 11111, token: "token-a" },
  "sandbox-b": { host: "127.0.0.1", port: 22222, token: "token-b" },
};

beforeEach(() => {
  localStorage.clear();
  setSelectedThemeId(null);
  vi.mocked(fetchThemes).mockResolvedValue([CUSTOM_THEME]);
  vi.mocked(deleteTheme).mockResolvedValue(undefined);
  vi.mocked(resolveConnection).mockImplementation((profile: Profile) =>
    Promise.resolve(CONNECTIONS[profile.id]),
  );
});

afterEach(() => {
  cleanup();
  setSelectedThemeId(null);
  vi.restoreAllMocks();
});

describe("ThemeSection", () => {
  it("picking a theme is a device-local choice, with no relay round trip", async () => {
    const user = userEvent.setup();
    render(<ThemeSection activeProfile={activeProfile} />);

    await user.click(await screen.findByText("Custom B"));

    expect(getSelectedThemeId()).toBe("custom-b");
    // The theme used to be a field on the profile, PATCHed onto its host.
    expect(updateProfileMeta).not.toHaveBeenCalled();
  });

  it("deletes a theme through the connected profile's own sidecar", async () => {
    const user = userEvent.setup();
    render(<ThemeSection activeProfile={activeProfile} />);

    await screen.findByText("Custom B");
    await openCardMenu(user, "Custom B");
    await user.click(await within(document.body).findByRole("menuitem", { name: en.common.delete }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: en.common.delete }));

    await vi.waitFor(() => expect(deleteTheme).toHaveBeenCalled());
    expect(deleteTheme).toHaveBeenCalledWith("127.0.0.1", 11111, "custom-b", "token-a");
  });

  it("offers a theme mirrored from another host, without offering to edit a file it can't write", async () => {
    const { setThemesForHost } = await import("@/lib/theme/themes");
    setThemesForHost(otherProfile.id, [{ ...CUSTOM_THEME, id: "from-b", name: "From B" }]);
    const user = userEvent.setup();

    render(<ThemeSection activeProfile={activeProfile} />);

    await screen.findByText("From B");
    await openCardMenu(user, "From B");

    const menu = within(await within(document.body).findByRole("menu"));
    // Duplicating is local work (it only seeds the import dialog), so it
    // survives; touching the file on the other machine does not.
    expect(menu.getByRole("menuitem", { name: en.common.copy })).toBeInTheDocument();
    expect(menu.queryByRole("menuitem", { name: en.common.edit })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: en.common.delete })).toBeNull();
  });
});
