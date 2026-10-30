import { findProfile } from "@/lib/profiles/profiles";

/**
 * The "Your agents" screen is the last step of the first run, and the
 * profile it belongs to already exists by then — so a relaunch would
 * otherwise drop the reader straight into the shell. This flag, written as
 * the screen opens and cleared by "Start", lets the gate bring them back.
 * It stores the profile id; a profile that has since been removed makes the
 * flag stale, which `getPendingAgentsProfileId` clears on the way.
 */
export const PENDING_AGENTS_STORAGE_KEY = "anywh:first-run:pending-agents";

export function getPendingAgentsProfileId(): string | null {
  const id = localStorage.getItem(PENDING_AGENTS_STORAGE_KEY);
  if (id === null) return null;
  if (findProfile(id) === undefined) {
    localStorage.removeItem(PENDING_AGENTS_STORAGE_KEY);
    return null;
  }
  return id;
}

export function setPendingAgents(profileId: string): void {
  localStorage.setItem(PENDING_AGENTS_STORAGE_KEY, profileId);
}

export function clearPendingAgents(): void {
  localStorage.removeItem(PENDING_AGENTS_STORAGE_KEY);
}
