/**
 * The app's own version, as the status bar prints it.
 *
 * A literal rather than a build-time `define` or a call to Tauri's
 * `getVersion()`: the define would have to be repeated in three configs
 * (`vite.config.ts` and both vitest ones) and go missing from whichever is
 * added next, and `getVersion()` is an IPC call that needs its own capability
 * and answers nothing outside a Tauri window — neither the unit tier nor a
 * browser `vite dev` would have a version to show. The cost is a third place
 * to bump on release, which `appVersion.test.ts` guards against forgetting.
 */
export const APP_VERSION = "0.1.8";

/**
 * The floor below which a stale relay is severe enough to warrant a banner
 * instead of the quiet per-profile affordance `relayDrift.ts` otherwise
 * shows for "older, by any margin". Bumped by hand, only once the client
 * actually starts depending on a relay-side feature by version — `0.0.0`
 * fires for nothing that exists today, on purpose: in `0.x`, every release
 * is a patch bump, so "older" and "missing a feature I need" are not the
 * same question, and this constant is what keeps them separate instead of
 * inferring the second from a version-distance threshold that would fire
 * for the wrong reason.
 */
export const MIN_RELAY_VERSION = "0.0.0";
