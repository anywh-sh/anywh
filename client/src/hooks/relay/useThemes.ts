import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchThemes } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { useForegroundSync } from "@/hooks/relay/useForegroundSync";
import type { Profile } from "@/lib/profiles/profiles";
import { applyTheme, cacheResolvedTheme, resolveTheme, type ResolvedTheme } from "@/lib/theme/themeApply";
import {
  getSelectedThemeId,
  getThemeStore,
  resolveSelectedTheme,
  setThemesForHost,
  subscribeSelectedTheme,
  subscribeThemes,
  themeCatalog,
  themeStoreKey,
  type CatalogEntry,
  type ThemeResolution,
} from "@/lib/theme/themes";

/** Reactive view of everything this device can paint — the built-ins plus
 * every mirrored registry's custom themes, with `profile`'s own registry
 * winning a duplicate id (it's the host the app is connected to, so it's the
 * one "add theme" writes to).
 *
 * The store snapshot is a dependency, not just a subscription: `themeCatalog`
 * reads the module-level store rather than taking it as an argument, so a memo
 * keyed only on the store key would keep handing back the previous list
 * after a theme is added — the component re-renders and shows stale content. */
export function useThemeCatalog(profile: Profile): CatalogEntry[] {
  const store = useSyncExternalStore(subscribeThemes, getThemeStore);
  const key = themeStoreKey(profile);
  return useMemo(() => themeCatalog(key), [store, key]);
}

/** The device's theme choice, and the setter that repaints the app. */
export function useSelectedTheme(): string | null {
  return useSyncExternalStore(subscribeSelectedTheme, getSelectedThemeId);
}

/**
 * Mirrors `profile`'s `GET /control/themes` into the local catalog on the
 * triggers `useForegroundSync` provides — deliberately the same triggers and
 * the same failure posture as `useProfileSync`: a failed fetch only reports
 * `supported: false` and never touches what's already stored, so an
 * unreachable host doesn't make its themes disappear mid-use.
 *
 * `supported` is false on a relay too old to have the route, which is what
 * the settings UI uses to explain that this host can't store custom themes
 * (the built-ins still work) instead of showing an empty list as if none
 * had been added yet.
 */
export function useThemeSync(profile: Profile): { supported: boolean } {
  const [supported, setSupported] = useState(true);
  // Guards against a response from the previous profile landing after a
  // switch — `profile.id` (not `host`) is what actually tells two profiles
  // apart, since every tailnet profile shares the same placeholder host.
  const currentProfileId = useRef(profile.id);
  currentProfileId.current = profile.id;

  const sync = useCallback(() => {
    const profileId = profile.id;
    const key = themeStoreKey(profile);
    resolveConnection(profile)
      .then(({ host, port, token }) => fetchThemes(host, port, token))
      .then((themes) => {
        if (currentProfileId.current !== profileId) return;
        setThemesForHost(key, themes);
        setSupported(true);
      })
      .catch(() => {
        if (currentProfileId.current === profileId) setSupported(false);
      });
  }, [
    profile.id,
    profile.host,
    profile.relayPort,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
  ]);

  useForegroundSync(sync);

  return { supported };
}

/**
 * The painted theme with every token filled in, without painting anything —
 * for consumers that need literal colors rather than CSS variables (xterm).
 */
export function useResolvedTheme(): ResolvedTheme {
  const store = useSyncExternalStore(subscribeThemes, getThemeStore);
  const selected = useSelectedTheme();
  return useMemo(() => resolveTheme(resolveSelectedTheme().theme), [store, selected]);
}

/**
 * Paints the device's chosen theme and keeps the boot cache current.
 *
 * `useLayoutEffect` rather than a plain effect so picking a theme repaints in
 * the same commit as the click, with no frame in the previous colors.
 */
export function useActiveTheme(): ThemeResolution {
  useSyncExternalStore(subscribeThemes, getThemeStore);
  useSelectedTheme();
  const { theme, missing } = resolveSelectedTheme();

  useLayoutEffect(() => {
    cacheResolvedTheme(applyTheme(theme));
  }, [theme]);

  return { theme, missing };
}
