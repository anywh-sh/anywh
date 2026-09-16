import type { ModelChoice } from "@/lib/relayClient";

export type ModelPreferenceMode = "lastUsed" | "fixed";

/** Never "default" on purpose — the fixed model has to be a real model, not
 * a synonym for "don't choose anything" (see removal of the "Padrão" option
 * from `ModelButton`). */
export type FixedModelChoice = Exclude<ModelChoice, "default">;

export interface ModelPreference {
  mode: ModelPreferenceMode;
  fixedModel: FixedModelChoice;
}

export const DEFAULT_MODEL_PREFERENCE: ModelPreference = { mode: "lastUsed", fixedModel: "sonnet" };

const VALID_MODES: ModelPreferenceMode[] = ["lastUsed", "fixed"];

/** No membership check against the known catalog here on purpose — at the
 * time this runs (app cold start, before any relay connection reported the
 * real catalog back) a legitimately-stored value like "opusplan" would still
 * fail an `includes` check against the fallback list. Format sanity only,
 * same reasoning as the relay's `isSetModelMessage`. */
function isModelPreference(value: unknown): value is ModelPreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    VALID_MODES.includes(candidate.mode as ModelPreferenceMode) &&
    typeof candidate.fixedModel === "string" &&
    candidate.fixedModel.length > 0
  );
}

/** Every field optional on purpose: absence *is* inheritance, so no
 * "inherit" sentinel value is needed anywhere. */
export interface ProfileSettings {
  defaultPath?: string;
  model?: ModelPreference;
  // theme?: ThemePreference;  — next one to land, no schema change needed
}

function isProfileSettings(value: unknown): value is ProfileSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.defaultPath !== undefined && typeof candidate.defaultPath !== "string") return false;
  if (candidate.model !== undefined && !isModelPreference(candidate.model)) return false;
  return true;
}

export type UpdateMode = "notify" | "auto-download" | "off";

const VALID_UPDATE_MODES: UpdateMode[] = ["notify", "auto-download", "off"];

/** App-wide, never per-profile — there is one running binary, not one per
 * profile, so this lives beside `global`/`byProfile` rather than inside
 * either of them. */
export interface AppSettings {
  updateMode?: UpdateMode;
  lastCheckedAt?: number;
  lastSeenVersion?: string;
  /** GitHub's ETag on the last successful check, round-tripped as
   * `If-None-Match` so a daily check against an unchanged release costs
   * nothing against the anonymous rate limit. */
  etag?: string;
  /** Set from a 403's `x-ratelimit-reset` — back off instead of retrying
   * into the same limit every launch. */
  nextCheckAllowedAt?: number;
}

function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.updateMode !== undefined && !VALID_UPDATE_MODES.includes(candidate.updateMode as UpdateMode)) return false;
  if (candidate.lastCheckedAt !== undefined && typeof candidate.lastCheckedAt !== "number") return false;
  if (candidate.lastSeenVersion !== undefined && typeof candidate.lastSeenVersion !== "string") return false;
  if (candidate.etag !== undefined && typeof candidate.etag !== "string") return false;
  if (candidate.nextCheckAllowedAt !== undefined && typeof candidate.nextCheckAllowedAt !== "number") return false;
  return true;
}

interface SettingsStore {
  version: 1;
  /** Applies to every profile that doesn't override it. */
  global: ProfileSettings;
  /** Per-profile overrides, keyed by `Profile.id`. */
  byProfile: Record<string, ProfileSettings>;
  /** Optional on purpose, same reasoning as every field of `ProfileSettings`
   * — absence is a valid, meaningful state (no bump to `version` needed: a
   * store from before this field existed already validates without it). A
   * corrupted `app` is handled by `loadStore`, not by `isSettingsStore` —
   * it falls back to `undefined` on its own rather than failing the whole
   * store and taking `byProfile` down with it. */
  app?: AppSettings;
}

const STORAGE_KEY = "anywh:settings";
const OLD_DEFAULT_PATHS_KEY = "anywh:default-paths";
const OLD_MODEL_PREFERENCE_KEY = "anywh:model-preference";

const EMPTY_STORE: SettingsStore = { version: 1, global: {}, byProfile: {} };

/** Deliberately doesn't look at `candidate.app` at all — a store that is
 * otherwise well-formed must validate regardless of what `app` holds,
 * malformed or absent alike. `loadStore` below is what decides `app`'s own
 * fate, in isolation from this check. */
function isSettingsStore(value: unknown): value is SettingsStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return false;
  if (!isProfileSettings(candidate.global)) return false;
  if (typeof candidate.byProfile !== "object" || candidate.byProfile === null) return false;
  return Object.values(candidate.byProfile as Record<string, unknown>).every(isProfileSettings);
}

function readLegacyMap<T>(key: string, isValid: (value: unknown) => value is T): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, T] => isValid(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** One-time migration of the old per-preference keys into `byProfile`, then
 * deletes them — same old-key cleanup as `useSessionDock.ts`, except here the
 * data is carried over instead of dropped: a configured default path or
 * model choice isn't disposable UI state the way a dock's width is. */
function migrateLegacyKeys(store: SettingsStore): SettingsStore {
  const oldPaths = readLegacyMap<string>(OLD_DEFAULT_PATHS_KEY, (value): value is string => typeof value === "string");
  const oldModels = readLegacyMap<ModelPreference>(OLD_MODEL_PREFERENCE_KEY, isModelPreference);
  if (Object.keys(oldPaths).length === 0 && Object.keys(oldModels).length === 0) return store;

  const byProfile = { ...store.byProfile };
  for (const [profileId, defaultPath] of Object.entries(oldPaths)) {
    byProfile[profileId] = { ...byProfile[profileId], defaultPath };
  }
  for (const [profileId, model] of Object.entries(oldModels)) {
    byProfile[profileId] = { ...byProfile[profileId], model };
  }

  localStorage.removeItem(OLD_DEFAULT_PATHS_KEY);
  localStorage.removeItem(OLD_MODEL_PREFERENCE_KEY);

  return { ...store, byProfile };
}

function loadStore(): SettingsStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isSettingsStore(parsed)) return migrateLegacyKeys(EMPTY_STORE);
    // A corrupted `app` falls back to `undefined` on its own — it never
    // takes `global`/`byProfile` down with it.
    const app = isAppSettings(parsed.app) ? parsed.app : undefined;
    return migrateLegacyKeys({ ...parsed, app });
  } catch {
    return migrateLegacyKeys(EMPTY_STORE);
  }
}

let store: SettingsStore = loadStore();
const listeners = new Set<() => void>();

/** Synchronous read of the current store — pair with `useSyncExternalStore`
 * (`subscribeSettings`) for reactive consumers, same pattern as
 * `getProfiles`/`subscribeProfiles`. */
export function readSettings(): SettingsStore {
  return store;
}

/** Replaces the whole store and persists it. Callers should spread from
 * `readSettings()` rather than constructing a `SettingsStore` from scratch,
 * so an update to one profile's settings never clobbers another's. */
export function writeSettings(next: SettingsStore): void {
  store = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Built-in default → global → per-profile override. Absence at a level
 * means "inherit", so there's no sentinel value to special-case. */
export function resolveSetting<K extends keyof ProfileSettings>(
  key: K,
  profileId: string,
): ProfileSettings[K] | undefined {
  return store.byProfile[profileId]?.[key] ?? store.global[key];
}
