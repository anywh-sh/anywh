import type { LocalFailure, StepStatus } from "@/lib/install/localInstall";
import type { LocalRelayProbe } from "@/lib/install/localRelay";
import { addProfile, findProfile, removeProfile, type Profile } from "@/lib/profiles/profiles";
import {
  dismissProfileSetup,
  getProfileSetupState,
  resumeProfileSetup,
  retryProfileSetup,
  subscribeProfileSetup,
} from "@/lib/profiles/profileSetup";

/**
 * Adopting the relay already on this machine: every profile its registry
 * knows is saved on this device, nothing is installed or created. The
 * preparing screen's other mode, as three steps — check this machine (the
 * probe already ran), read the existing install (the profiles are saved),
 * connect (the active one answers `GET /sessions`, through the same
 * `profileSetup` verification every other path uses; the shell's session
 * sync clears the rest once it reaches them).
 *
 * Adopted profiles are saved `unverified` before anything is dialled, the
 * same order every path keeps, so a closed app picks the verification up
 * on the next launch. What a failed verification does next is the
 * reader's call: "try again" keeps every adopted profile and only dials
 * again (`retryVerify`); giving up — back to the welcome, or on to the
 * terminal — takes them all off this device (`rollback`), so the next
 * attempt starts from a clean install. A `default.env` the registry
 * doesn't know is a stray relay run's leftover and is never adopted.
 *
 * Module-level, like `localInstall.ts`: a remount must not adopt twice.
 */

export type AdoptStep = "check" | "read" | "connect";
export const ADOPT_STEPS: AdoptStep[] = ["check", "read", "connect"];

export interface AdoptState {
  status: "idle" | "running" | "failed" | "ready";
  /** Every profile this run saved, in the registry's order. */
  profiles: Profile[];
  /** The one being verified: `default` when the registry has it, else the
   * first. */
  activeId: string | null;
  failure: LocalFailure | null;
}

function initialState(): AdoptState {
  return { status: "idle", profiles: [], activeId: null, failure: null };
}

let state: AdoptState = initialState();
const listeners = new Set<() => void>();
let unsubscribeSetup: (() => void) | null = null;

function publish(next: AdoptState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getAdoptState(): AdoptState {
  return state;
}

export function subscribeAdopt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopWatchingSetup(): void {
  unsubscribeSetup?.();
  unsubscribeSetup = null;
}

/** The registry's profiles as this device's, unverified. Pure. */
export function adoptableProfiles(probe: LocalRelayProbe): Profile[] {
  return probe.profiles
    .filter((p) => p.registered)
    .map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      host: p.host ?? "127.0.0.1",
      relayPort: p.port ?? 8765,
      localRelay: true,
      unverified: true,
    }));
}

/** Whether this probe is one to adopt rather than install over. */
export function canAdopt(probe: LocalRelayProbe | null): boolean {
  return Boolean(probe?.installed && probe.profiles.some((p) => p.registered));
}

/** Saves every registered profile and verifies the active one. */
export function adoptLocalProfiles(probe: LocalRelayProbe): void {
  stopWatchingSetup();
  const profiles = adoptableProfiles(probe);
  const active = profiles.find((p) => p.id === "default") ?? profiles[0];
  if (!active) {
    publish(initialState());
    return;
  }
  for (const profile of profiles) addProfile(profile);
  publish({ status: "running", profiles, activeId: active.id, failure: null });
  watchSetup();
  resumeProfileSetup(active);
}

/** Mirrors `profileSetup`'s outcome for the active profile: ready is
 * done, a failed connect or verify is a relay on disk that doesn't
 * answer. */
function watchSetup(): void {
  stopWatchingSetup();
  const sync = (): void => {
    const setup = getProfileSetupState().state;
    if (!setup || !("profile" in setup) || setup.profile.id !== state.activeId) return;
    if (setup.status === "ready") {
      stopWatchingSetup();
      publish({ ...state, status: "ready", failure: null });
    } else if (setup.status === "failed") {
      publish({ ...state, status: "failed", failure: { code: "unresponsive", detail: "" } });
    } else if (state.status !== "running") {
      publish({ ...state, status: "running", failure: null });
    }
  };
  unsubscribeSetup = subscribeProfileSetup(sync);
  sync();
}

/** "Try again": the adopted profiles stay; only the dialling repeats. */
export function retryVerify(): void {
  if (state.status !== "failed" || !state.activeId) return;
  publish({ ...state, status: "running", failure: null });
  watchSetup();
  const setup = getProfileSetupState().state;
  if (setup?.status === "failed" && setup.stage !== "claim" && setup.profile.id === state.activeId) {
    retryProfileSetup();
    return;
  }
  const profile = findProfile(state.activeId);
  if (profile) resumeProfileSetup(profile);
}

/** Giving up: every profile this run adopted comes off this device and
 * the verification is let go, so nothing is left half-connected. */
export function rollback(): void {
  stopWatchingSetup();
  const adopted = state.profiles;
  dismissProfileSetup();
  for (const profile of adopted) removeProfile(profile.id);
  publish(initialState());
}

/** The three rows the screen draws. */
export function adoptSteps(adopt: AdoptState): Array<{ key: AdoptStep; status: StepStatus }> {
  const connect: StepStatus = adopt.status === "ready" ? "done" : adopt.status === "failed" ? "failed" : adopt.status === "running" ? "running" : "pending";
  const earlier: StepStatus = adopt.status === "idle" ? "pending" : "done";
  return [
    { key: "check", status: earlier },
    { key: "read", status: earlier },
    { key: "connect", status: connect },
  ];
}

export function __resetAdoptForTests(): void {
  stopWatchingSetup();
  state = initialState();
}
