import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ModelChoice } from "@/lib/relay/relayClient";
import {
  DEFAULT_MODEL_PREFERENCE,
  readSettings,
  resolveSetting,
  subscribeSettings,
  writeSettings,
  type FixedModelChoice,
  type ModelPreference,
  type ModelPreferenceMode,
} from "@/lib/settings";

export { DEFAULT_MODEL_PREFERENCE, type FixedModelChoice, type ModelPreference, type ModelPreferenceMode };

const LAST_MODEL_STORAGE_KEY = "anywh:last-model";

type LastModelMap = Record<string, ModelChoice>;

function readLastModels(): LastModelMap {
  try {
    const raw = localStorage.getItem(LAST_MODEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, ModelChoice] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Model that a new conversation for a profile should preselect, resolved
 * from the preference configured in Settings — standalone read (outside a
 * React component), same reasoning as `getDefaultPath`. "last used" mode
 * falls back to "sonnet" when the profile has no history yet (first-ever
 * use), since we only support Claude Code today and Sonnet is its
 * lowest-common-denominator default across profiles/accounts.
 */
export function getPreferredModel(profileId: string): ModelChoice {
  const preference = resolveSetting("model", profileId) ?? DEFAULT_MODEL_PREFERENCE;
  if (preference.mode === "fixed") return preference.fixedModel;
  return readLastModels()[profileId] ?? "sonnet";
}

/**
 * Records the last model used by a profile — called whenever a session's
 * `model` changes to a concrete value (`ChatPanel`), regardless of whether
 * it was the preselection itself, `ModelButton`, or a typed `/model`. Only
 * consumed by "lastUsed" mode, but always recorded: switching the mode back
 * to "lastUsed" later shouldn't lose what already ran in the meantime. Kept
 * outside `SettingsStore` on purpose — it's automatic history, not a
 * user-configured preference, so it doesn't belong in the synced store.
 */
export function setLastModel(profileId: string, model: ModelChoice): void {
  const current = readLastModels();
  if (current[profileId] === model) return;
  localStorage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({ ...current, [profileId]: model }));
}

/** Per-profile model preselection preference, configured in Settings —
 * backed by the shared `SettingsStore` (`@/lib/settings`). */
export function useModelPreference() {
  const store = useSyncExternalStore(subscribeSettings, readSettings);

  const preferences = useMemo(() => {
    const result: Record<string, ModelPreference> = {};
    for (const [profileId, settings] of Object.entries(store.byProfile)) {
      if (settings.model !== undefined) result[profileId] = settings.model;
    }
    return result;
  }, [store]);

  const setPreference = useCallback((profileId: string, preference: ModelPreference) => {
    const current = readSettings();
    writeSettings({
      ...current,
      byProfile: {
        ...current.byProfile,
        [profileId]: { ...current.byProfile[profileId], model: preference },
      },
    });
  }, []);

  return { preferences, setPreference };
}
