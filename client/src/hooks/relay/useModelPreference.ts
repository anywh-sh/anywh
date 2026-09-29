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

/** Keyed by `lastModelKey` — one entry per profile *and agent*, since a
 * model id only means something to the agent that listed it. A bare
 * profile id is how entries were keyed while Claude was the only agent;
 * still read as a fallback, and harmless for any other agent — the caller
 * only applies a model that agent's catalog lists (`ChatPanel`). */
type LastModelMap = Record<string, ModelChoice>;

function lastModelKey(profileId: string, agentId: string): string {
  return `${profileId}:${agentId}`;
}

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
 * React component), same reasoning as `getDefaultPath`. `null` when there's
 * nothing to preselect (no history yet in "last used" mode): the session
 * then runs the agent's own default, which its catalog names — no fallback
 * model is hardcoded here, since none would be valid for every agent. The
 * result may still belong to another agent (a "fixed" pick is one agent's
 * model id); the caller checks it against the session's catalog.
 */
export function getPreferredModel(profileId: string, agentId: string): ModelChoice | null {
  const preference = resolveSetting("model", profileId) ?? DEFAULT_MODEL_PREFERENCE;
  if (preference.mode === "fixed") return preference.fixedModel;
  const lastModels = readLastModels();
  return lastModels[lastModelKey(profileId, agentId)] ?? lastModels[profileId] ?? null;
}

/**
 * Records the last model used by a profile under a given agent — called
 * whenever a session's `model` changes to a concrete value (`ChatPanel`),
 * regardless of whether it was the preselection itself, `ModelButton`, or a
 * typed `/model`. Only consumed by "lastUsed" mode, but always recorded:
 * switching the mode back to "lastUsed" later shouldn't lose what already
 * ran in the meantime. Kept outside `SettingsStore` on purpose — it's
 * automatic history, not a user-configured preference, so it doesn't belong
 * in the synced store.
 */
export function setLastModel(profileId: string, agentId: string, model: ModelChoice): void {
  const current = readLastModels();
  const key = lastModelKey(profileId, agentId);
  if (current[key] === model) return;
  localStorage.setItem(LAST_MODEL_STORAGE_KEY, JSON.stringify({ ...current, [key]: model }));
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
