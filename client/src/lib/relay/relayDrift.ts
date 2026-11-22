import { isUnreleasedVersion } from "@/lib/install/appVersion";
import { compareVersions } from "@/lib/install/semver";

/**
 * Whether the app should ask this relay to update itself to the app's own
 * version, with no one asking: the relay can (`self_update`), it runs a
 * release strictly older than the app, and the app is a release itself (a
 * build from source has no release to point a relay at). Never a downgrade:
 * a relay ahead of the app is left alone.
 */
export function shouldAutoUpdateRelay(info: { version?: string; features?: readonly string[] }, appVersion: string): boolean {
  if (!info.features?.includes("self_update") || info.version === undefined) return false;
  if (isUnreleasedVersion(info.version) || isUnreleasedVersion(appVersion)) return false;
  const vsApp = compareVersions(info.version, appVersion);
  return vsApp !== null && vsApp < 0;
}
