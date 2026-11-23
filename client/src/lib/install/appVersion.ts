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
 * it as a release to compare against. Same value as scripts/version.mjs's and relay_setup.rs's
 * (appVersion.test.ts keeps the three in step).
 */
export const UNRELEASED_VERSION = "0.0.0";

/** Whether `version` is that placeholder — the one check every comparison
 * against a release goes through first (relay drift, the update check). */
export function isUnreleasedVersion(version: string): boolean {
  return version === UNRELEASED_VERSION;
}
