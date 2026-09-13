import { LAST_PROFILE_STORAGE_KEY } from "@/lib/profiles";

/**
 * Whether the first-run flow owns the window.
 *
 * `App` shows the first run instead of the shell while this device has no
 * profile — but a profile is saved *before* it is verified
 * (`claimAndSaveProfile` runs ahead of `connectStep`/`verifyStep` in
 * profileSetup.ts), so the list stops being empty in the middle of the flow.
 * Gating on the list alone would unmount the wizard in the user's face the
 * moment the claim lands. This flag is the second half of the gate's
 * predicate: once the first run has taken over, only `finishFirstRun`
 * hands the window back.
 *
 * Module-level, not React state, for the same reason `profileSetup.ts` is:
 * the first-run root can be unmounted and remounted (StrictMode, a language
 * switch re-rendering the tree) without the flow forgetting it was in
 * progress.
 */
let active = false;
/**
 * The user has crossed into the shell this run — set by `finishFirstRun`.
 * Read by the gate's third clause: a device whose only profile is still
 * `unverified` reopens on the first run, resuming that profile's setup,
 * but once the user has dismissed that and chosen the shell, the gate must
 * not bounce them straight back. In memory only: the next launch tries
 * again, which is the point.
 */
let shellChosen = false;
const listeners = new Set<() => void>();

export interface FirstRunSnapshot {
  active: boolean;
  shellChosen: boolean;
}

let snapshot: FirstRunSnapshot = { active, shellChosen };

function publish(): void {
  snapshot = { active, shellChosen };
  for (const listener of listeners) listener();
}

export function isFirstRunActive(): boolean {
  return active;
}

export function getFirstRunSnapshot(): FirstRunSnapshot {
  return snapshot;
}

export function subscribeFirstRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Idempotent — the first-run root calls it on every render, so the flag is
 * true for as long as the screen is on, whatever brought it there. */
export function beginFirstRun(): void {
  if (active) return;
  active = true;
  publish();
}

/**
 * The one way out. Records `profileId` as the active profile *before*
 * flipping the flag: the shell mounts on the very next render and
 * `useActiveProfile`'s initial read happens then — without the key already
 * written it would fall back to `profiles[0]`, which is only the right
 * answer by coincidence.
 */
export function finishFirstRun(profileId: string): void {
  localStorage.setItem(LAST_PROFILE_STORAGE_KEY, profileId);
  active = false;
  shellChosen = true;
  publish();
}

/** Which of the first-run screens is showing. Lives here rather than in the
 * component so the dictionary can key its eyebrow copy on it — a screen
 * added without a crumb is then a compile error, not a blank label. */
export type FirstRunScreen = "home" | "connect" | "code" | "manual";

export function __resetFirstRunForTests(): void {
  active = false;
  shellChosen = false;
  snapshot = { active, shellChosen };
}
