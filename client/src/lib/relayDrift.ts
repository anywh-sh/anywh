import { compareVersions } from "@/lib/semver";

/**
 * "none" — nothing to say (relay unknown, equal, or newer than the app;
 * a self-hosted relay updated ahead of the app is normal, not a problem).
 * "affordance" — a relay strictly older than the app, by any margin: severity
 * is about *where* this shows (a quiet per-profile line, never the app's
 * top banner — that one is reserved for the app's own updates), not about
 * how far behind the relay is.
 * "banner" — reserved for the day `MIN_RELAY_VERSION` (appVersion.ts) is
 * actually bumped past some relay version in the field. Fires for nothing
 * today, on purpose.
 */
export type RelayDriftSeverity = "none" | "affordance" | "banner";

/** What the affordance offers, when there is one. macOS never gets
 * "update-in-app": Homebrew owns the relay there (relay_setup.rs refuses to
 * pass `--version` on that platform for the same reason), so re-running the
 * in-app installer wouldn't even pick a version — the only honest action is
 * pointing at the command that does. */
export type RelayDriftAction = "update-in-app" | "brew-upgrade" | null;

export interface RelayDrift {
  severity: RelayDriftSeverity;
  action: RelayDriftAction;
}

const NO_DRIFT: RelayDrift = { severity: "none", action: null };

/**
 * `relayVersion` is `null` for the large population of relays that predate
 * `GET /host-info`'s `version` field (Fase A4) — silently "none", the same
 * as an unreachable or malformed one, since there is nothing to compare
 * against yet. `platform` is the app's own OS (`currentPlatform()`), not
 * the relay's — a local relay only ever runs on the same machine as the app
 * that's asking.
 */
export function evaluateRelayDrift(
  relayVersion: string | null,
  appVersion: string,
  minRelayVersion: string,
  platform: string | null,
): RelayDrift {
  if (relayVersion === null) return NO_DRIFT;

  const vsApp = compareVersions(relayVersion, appVersion);
  if (vsApp === null || vsApp >= 0) return NO_DRIFT;

  const vsFloor = compareVersions(relayVersion, minRelayVersion);
  const severity: RelayDriftSeverity = vsFloor !== null && vsFloor < 0 ? "banner" : "affordance";
  const action: RelayDriftAction = platform === "macos" ? "brew-upgrade" : "update-in-app";
  return { severity, action };
}
