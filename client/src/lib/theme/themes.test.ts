import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";
import type { Theme } from "@/lib/theme/theme";

const STORAGE_KEY = "anywh:themes";
const SELECTION_KEY = "anywh:theme";
const PROFILES_KEY = "anywh:profiles";
const LAST_PROFILE_KEY = "anywh:last-profile";

const theme: Theme = {
  id: "nord-ish",
  name: "Nord-ish",
  appearance: "dark",
  colors: {},
  terminal: {},
} as Theme;

const otherHostTheme: Theme = { ...theme, id: "solar-ish", name: "Solar-ish" };

// Two tailnet profiles always share the same placeholder
// `host` (`profileImport.ts` writes "127.0.0.1" for both) — `id` is the only
// field that actually tells them apart.
const tailnetProfileA: Profile = {
  id: "sandbox-a",
  label: "Sandbox A",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key-a",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

const tailnetProfileB: Profile = {
  ...tailnetProfileA,
  id: "sandbox-b",
  label: "Sandbox B",
  tailnetAuthKey: "key-b",
};

const directProfile: Profile = {
  id: "direct",
  label: "Direct",
  host: "192.168.0.10",
  relayPort: 8765,
};

/** The selection is read once, at import — every case that cares about what
 * was in storage before that has to load the module itself. */
async function loadThemes(): Promise<typeof import("@/lib/theme/themes")> {
  vi.resetModules();
  return import("@/lib/theme/themes");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("themeStoreKey", () => {
  it("is the profile id for a tailnet profile, not the shared placeholder host", async () => {
    const { themeStoreKey } = await loadThemes();
    expect(themeStoreKey(tailnetProfileA)).toBe("sandbox-a");
    expect(themeStoreKey(tailnetProfileB)).toBe("sandbox-b");
  });

  it("is the host itself for a direct profile", async () => {
    const { themeStoreKey } = await loadThemes();
    expect(themeStoreKey(directProfile)).toBe("192.168.0.10");
  });
});

describe("the mirrored registries", () => {
  it("does not let two tailnet profiles' custom themes collide", async () => {
    const { customThemesForHost, setThemesForHost, themeStoreKey } = await loadThemes();
    setThemesForHost(themeStoreKey(tailnetProfileA), [theme]);
    expect(customThemesForHost(themeStoreKey(tailnetProfileA))).toEqual([theme]);
    expect(customThemesForHost(themeStoreKey(tailnetProfileB))).toEqual([]);
  });

  it("offers every mirrored registry's themes, tagged with the one holding the file", async () => {
    const { setThemesForHost, themeCatalog } = await loadThemes();
    setThemesForHost("sandbox-a", [theme]);
    setThemesForHost("192.168.0.10", [otherHostTheme]);

    const catalog = themeCatalog("sandbox-a");
    // Built-ins first, and they belong to no registry.
    expect(catalog[0].storeKey).toBeUndefined();
    expect(catalog.find((entry) => entry.theme.id === "nord-ish")?.storeKey).toBe("sandbox-a");
    expect(catalog.find((entry) => entry.theme.id === "solar-ish")?.storeKey).toBe("192.168.0.10");
  });

  it("gives the connected registry the duplicate id, since that's the file it can write", async () => {
    const { setThemesForHost, themeCatalog } = await loadThemes();
    setThemesForHost("sandbox-a", [{ ...theme, name: "From A" }]);
    setThemesForHost("192.168.0.10", [{ ...theme, name: "From the other host" }]);

    const fromHost = themeCatalog("192.168.0.10").find((entry) => entry.theme.id === "nord-ish");
    expect(fromHost?.theme.name).toBe("From the other host");
    expect(fromHost?.storeKey).toBe("192.168.0.10");
  });
});

describe("the device-wide selection", () => {
  it("paints the built-in when nothing was ever chosen", async () => {
    const { resolveSelectedTheme, getSelectedThemeId } = await loadThemes();
    expect(getSelectedThemeId()).toBeNull();
    expect(resolveSelectedTheme().missing).toBe(false);
    expect(resolveSelectedTheme().theme.id).toBe("default");
  });

  it("survives a restart, and keeps painting a theme mirrored from another host", async () => {
    const first = await loadThemes();
    // A theme that lives on a host this device is not connected to: the
    // selection is the device's, not that profile's, so it still paints.
    first.setThemesForHost("192.168.0.10", [otherHostTheme]);
    first.setSelectedThemeId("solar-ish");

    const second = await loadThemes();
    expect(second.getSelectedThemeId()).toBe("solar-ish");
    expect(second.resolveSelectedTheme()).toEqual({ theme: otherHostTheme, missing: false });
  });

  it("reports a selection no registry knows about instead of silently repairing it", async () => {
    const { setSelectedThemeId, resolveSelectedTheme } = await loadThemes();
    setSelectedThemeId("deleted-elsewhere");
    expect(resolveSelectedTheme()).toEqual({ theme: expect.objectContaining({ id: "default" }), missing: true });
    // Still the stored choice: the theme may come back on the next sync.
    expect(localStorage.getItem(SELECTION_KEY)).toBe("deleted-elsewhere");
  });

  it("adopts the theme the active profile used to carry, once, on upgrade", async () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        { id: "other", label: "Other", host: "192.168.0.10", relayPort: 8765, themeId: "solar-ish" },
        { id: "direct", label: "Direct", host: "192.168.0.10", relayPort: 8765, themeId: "nord-ish" },
      ]),
    );
    localStorage.setItem(LAST_PROFILE_KEY, "direct");

    const first = await loadThemes();
    expect(first.getSelectedThemeId()).toBe("nord-ish");

    // Written down, so clearing it on this device is not undone by the
    // profile that still carries the old field.
    first.setSelectedThemeId(null);
    const second = await loadThemes();
    expect(second.getSelectedThemeId()).toBeNull();
  });

  it("leaves a fresh install on the built-in, with no profile to inherit from", async () => {
    const { getSelectedThemeId } = await loadThemes();
    expect(getSelectedThemeId()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
