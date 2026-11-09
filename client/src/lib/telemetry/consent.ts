/**
 * Whether the app may send anything, as one answer.
 *
 * Precedence, strongest first: the environment (`DO_NOT_TRACK`,
 * `ANYWH_TELEMETRY_DISABLED`) → the choice saved on this device → nothing
 * chosen yet. The environment beats the saved choice without rewriting it:
 * unset the variable and the app goes back to what the user picked.
 *
 *  - `enabled`           sending is allowed
 *  - `disabled_by_env`   an environment variable turns it off
 *  - `disabled_by_user`  the user said no (banner or Settings)
 *  - `pending_banner`    never asked: nothing is sent, events wait in memory
 *  - `pending_env`       the environment has not been read yet (an
 *                        instant at startup): the same, until it is known
 */
export type ConsentState = "enabled" | "disabled_by_env" | "disabled_by_user" | "pending_banner" | "pending_env";

/** `envDisabled` is `null` until the native side has answered. */
export function resolveConsent(envDisabled: boolean | null, optedIn: boolean | null): ConsentState {
  if (envDisabled === true) return "disabled_by_env";
  if (optedIn === false) return "disabled_by_user";
  if (envDisabled === null) return "pending_env";
  return optedIn === true ? "enabled" : "pending_banner";
}

/** Events may be held in memory in these states: a later answer can still
 * make them sendable. */
export function isPending(state: ConsentState): boolean {
  return state === "pending_banner" || state === "pending_env";
}
