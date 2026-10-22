import { version } from "../../../package.json";

/**
 * The app's own version, as the status bar prints it.
 *
 * Read from `client/package.json`, which git keeps at `UNRELEASED_VERSION`:
 * the release build stamps the tag's version into it (and into
 * tauri.conf.json, which Tauri stamps on the bundle) before compiling —
 * `node scripts/version.mjs stamp`, see .anywh/skills/release/SKILL.md. An
 * import rather than a build-time `define` or Tauri's `getVersion()`: the
 * define would have to be repeated in every Vite/Vitest config, and
 * `getVersion()` is an IPC call that answers nothing outside a Tauri window
 * — neither the unit tier nor a browser `vite dev` would have a version.
 */
export const APP_VERSION: string = version;

/**
 * What every manifest says in git, and so what a build from source that no
 * release stamped reports — for the app and for a relay run from a checkout
 * alike. Means "unknown", not "older than everything": nothing should treat
 * it as a release to compare against. Same value as scripts/version.mjs's.
 */
export const UNRELEASED_VERSION = "0.0.0";

/**
 * The floor below which a stale relay is severe enough to warrant a banner
 * instead of the quiet per-profile affordance `relayDrift.ts` otherwise
 * shows for "older, by any margin". Bumped by hand, only once the client
 * actually starts depending on a relay-side feature by version — `0.0.0`
 * fires for nothing that exists today, on purpose: every merge is a
 * version, so "older" and "missing a feature I need" are not the same
 * question, and this constant is what keeps them separate instead of
 * inferring the second from a version-distance threshold that would fire
 * for the wrong reason. (An incompatible wire is not this constant's job
 * either: `WS_PROTOCOL_VERSION`'s handshake already refuses it.)
 */
export const MIN_RELAY_VERSION = "0.0.0";
