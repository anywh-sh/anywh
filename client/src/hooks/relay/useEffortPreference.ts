const LAST_EFFORT_STORAGE_KEY = "anywh:last-effort";

/** Keyed by `${profileId}:${agentId}` — an effort id only means something to
 * the agent that listed it, same keying as `anywh:last-model`. */
type LastEffortMap = Record<string, string>;

function lastEffortKey(profileId: string, agentId: string): string {
  return `${profileId}:${agentId}`;
}

function readLastEfforts(): LastEffortMap {
  try {
    const raw = localStorage.getItem(LAST_EFFORT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
    );
  } catch {
    return {};
  }
}

/** The last effort a profile used under an agent, or `null`. There is no
 * "fixed" mode in Settings: a new conversation just resumes the last pick.
 * The caller only applies it when the conversation's effective model lists it
 * (`ChatPanel`). */
export function getLastEffort(profileId: string, agentId: string): string | null {
  return readLastEfforts()[lastEffortKey(profileId, agentId)] ?? null;
}

/** Recorded on every concrete `effort_state` change, whoever caused it
 * (dropdown, `/effort`, or the restore itself). Clearing a pick (back to the
 * default) is deliberately not recorded: a model switch also clears it, and
 * that must not erase what the user last chose. */
export function setLastEffort(profileId: string, agentId: string, effort: string): void {
  const current = readLastEfforts();
  const key = lastEffortKey(profileId, agentId);
  if (current[key] === effort) return;
  localStorage.setItem(LAST_EFFORT_STORAGE_KEY, JSON.stringify({ ...current, [key]: effort }));
}
