import { BUILTIN_THEMES, DEFAULT_THEME } from "@/lib/theme/builtinThemes";
import { getProfiles, isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import type { Theme } from "@/lib/theme/theme";

/** The key a profile's theme registry is stored/looked up under. Normally
 * `profile.host` — a registry belongs to the machine that stores it, and two
 * profiles on the same real host share the same file. A tailnet profile
 * breaks that: every one of them has `host` set to the same
 * `127.0.0.1` sidecar placeholder (`profileImport.ts`), so keying by host
 * would make two unrelated tailnet profiles' custom themes collide — `id` is
 * the only field that actually tells them apart. */
export function themeStoreKey(profile: Profile): string {
  return isTailnetProfile(profile) ? profile.id : profile.host;
}

/**
 * Local mirror of each host's theme registry, plus the built-ins.
 *
 * Keyed by host, not merged into one flat list, because a theme registry
 * belongs to the machine that *stores* it: this device can legitimately know
 * profiles from more than one host (see `syncProfilesForHost`), and adding a
 * theme means writing a file on one particular machine. Which theme this
 * device *paints* is a separate, device-wide question — see the selection
 * store below.
 *
 * Persisted so the catalog survives a cold start and an unreachable host —
 * a theme whose file lives on a host that's currently down should still
 * paint, not snap back to the built-in.
 */
interface ThemeStore {
  version: 1;
  byHost: Record<string, Theme[]>;
}

const STORAGE_KEY = "anywh:themes";

const EMPTY_STORE: ThemeStore = { version: 1, byHost: {} };

function readStore(): ThemeStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STORE;
    const candidate = parsed as ThemeStore;
    if (candidate.version !== 1 || typeof candidate.byHost !== "object" || candidate.byHost === null) {
      return EMPTY_STORE;
    }
    return candidate;
  } catch {
    return EMPTY_STORE;
  }
}

let store: ThemeStore = readStore();
const listeners = new Set<() => void>();

/** Synchronous read — pair with `subscribeThemes` in a `useSyncExternalStore`
 * (see `useThemes`), same shape as `getProfiles`/`subscribeProfiles`. */
export function getThemeStore(): ThemeStore {
  return store;
}

export function subscribeThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replaces what this device knows about one host's registry — the write
 * side of `useThemeSync`. Never called on a failed fetch: an unreachable
 * host must not look like a host with no themes. `host` here is really a
 * `themeStoreKey` (a profile id for a tailnet profile) — kept as the
 * parameter name since a direct profile's key genuinely is its host. */
export function setThemesForHost(host: string, themes: Theme[]): void {
  const current = store.byHost[host];
  if (current && current.length === themes.length && current.every((theme, i) => theme.id === themes[i].id && theme.updatedAt === themes[i].updatedAt)) {
    return;
  }
  store = { ...store, byHost: { ...store.byHost, [host]: themes } };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  for (const listener of listeners) listener();
}

/** Custom themes registered on `host`. */
export function customThemesForHost(host: string): Theme[] {
  return store.byHost[host] ?? [];
}

/** A theme as the catalog offers it: the theme itself plus which registry
 * it came from, since editing or deleting one means talking to the machine
 * that holds the file. `storeKey` is absent for a built-in, which has no
 * file anywhere. */
export interface CatalogEntry {
  theme: Theme;
  storeKey?: string;
}

/**
 * Everything this device can paint right now: the built-ins first (they
 * exist even with every relay down), then the custom themes of every
 * registry this device has mirrored — `preferredKey`'s first, so the host
 * the app is actually connected to wins a duplicate id.
 *
 * The union is what makes the selection device-wide: a theme added from the
 * machine at work keeps painting after switching to a profile on the laptop
 * at home, even though only one of those registries holds the file.
 */
export function themeCatalog(preferredKey?: string): CatalogEntry[] {
  const entries: CatalogEntry[] = BUILTIN_THEMES.map((theme) => ({ theme }));
  const seen = new Set(entries.map((entry) => entry.theme.id));
  const keys = Object.keys(store.byHost).sort((a, b) =>
    a === preferredKey ? -1 : b === preferredKey ? 1 : 0,
  );
  for (const key of keys) {
    for (const theme of store.byHost[key]) {
      if (seen.has(theme.id)) continue;
      seen.add(theme.id);
      entries.push({ theme, storeKey: key });
    }
  }
  return entries;
}

// --- Selection ------------------------------------------------------------
//
// Which theme the app paints is device-wide and device-local: one choice for
// every profile, stored here and never sent to a relay. It used to be a
// per-profile field (`profile.themeId`, synced through the host's
// profiles.json), which meant switching profile repainted the whole app and
// the same person on two machines couldn't have a dark one and a light one.

const SELECTION_KEY = "anywh:theme";
const LAST_PROFILE_KEY = "anywh:last-profile";

/** One-time read of the per-profile selection this setting replaced, so an
 * upgrade keeps painting what the user had chosen instead of snapping back
 * to the built-in. The active profile's theme wins — it's the one on screen
 * when the app last closed; any other profile carrying one is the tiebreak.
 * `profile.themeId` is never written again after this. */
function legacyProfileSelection(): string | null {
  const profiles = getProfiles();
  if (profiles.length === 0) return null;
  const lastId = localStorage.getItem(LAST_PROFILE_KEY);
  const last = profiles.find((profile) => profile.id === lastId);
  return last?.themeId ?? profiles.find((profile) => profile.themeId)?.themeId ?? null;
}

function readSelection(): string | null {
  try {
    const stored = localStorage.getItem(SELECTION_KEY);
    if (stored !== null) return stored === "" ? null : stored;
    const adopted = legacyProfileSelection();
    localStorage.setItem(SELECTION_KEY, adopted ?? "");
    return adopted;
  } catch {
    return null;
  }
}

let selection: string | null = readSelection();
const selectionListeners = new Set<() => void>();

/** `null` means the built-in default — stored as "no theme" rather than as
 * its id, which is what makes it the fallback for a selection whose file is
 * gone. */
export function getSelectedThemeId(): string | null {
  return selection;
}

export function subscribeSelectedTheme(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

export function setSelectedThemeId(id: string | null): void {
  if (selection === id) return;
  selection = id;
  try {
    localStorage.setItem(SELECTION_KEY, id ?? "");
  } catch {
    // Nothing to do about a full quota here — the choice still applies to
    // this run, it just won't survive a restart.
  }
  for (const listener of selectionListeners) listener();
}

export interface ThemeResolution {
  theme: Theme;
  /** True when the selected id isn't in any registry this device has
   * mirrored — deleted from another device, or a host that hasn't synced
   * yet. The selection is deliberately left alone (the theme may come back),
   * so this is a state to report, not to repair. */
  missing: boolean;
}

export function resolveSelectedTheme(): ThemeResolution {
  if (!selection) return { theme: DEFAULT_THEME, missing: false };
  const found = themeCatalog().find((entry) => entry.theme.id === selection);
  return found ? { theme: found.theme, missing: false } : { theme: DEFAULT_THEME, missing: true };
}
