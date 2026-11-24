import { isUnreleasedVersion } from "@/lib/install/appVersion";
import { compareVersions } from "@/lib/install/semver";
import { legacyUpgradeKind } from "@/lib/relay/legacyRelayUpgrade";
import type { HostInfo } from "@/lib/relay/filesClient";
import {
  INSTALLER_CODES,
  INSTALLER_STEPS,
  RELAY_PLATFORMS,
  RELAY_UPDATE_REASONS,
  RELAY_UPDATE_REQUEST_RESULTS,
  VERSION_MAX_LENGTH,
  VERSION_PATTERN,
  type EventProps,
} from "@/lib/telemetry/events";

/**
 * What a relay's answers reduce to before they leave: closed lists only.
 * The relay's own words (an installer's message, an error's text) never
 * do — a code is kept only when it is one of the installer's known ones.
 */

function closed<T extends readonly string[]>(values: T, pick: string | null | undefined): T[number] {
  return pick !== null && pick !== undefined && (values as readonly string[]).includes(pick) ? pick : "other";
}

/** A version as the registry accepts it, or nothing. */
export function versionOrNone(version: string | null | undefined): string | undefined {
  return version !== null && version !== undefined && version.length <= VERSION_MAX_LENGTH && VERSION_PATTERN.test(version) ? version : undefined;
}

export function relayVsApp(relayVersion: string | undefined, appVersion: string): EventProps<"relay_seen">["vs_app"] {
  if (relayVersion === undefined || isUnreleasedVersion(relayVersion) || isUnreleasedVersion(appVersion)) return "unknown";
  const order = compareVersions(relayVersion, appVersion);
  if (order === null) return "unknown";
  return order === 0 ? "same" : order < 0 ? "older" : "newer";
}

/** How this relay gets updated, whether or not it needs it right now. */
export function relayUpdatePath(info: Pick<HostInfo, "features" | "updateSupport" | "platform">): EventProps<"relay_seen">["update_path"] {
  if (info.features?.includes("self_update")) return "self_update";
  return legacyUpgradeKind(info) ?? "none";
}

export function relayPlatform(platform: string | undefined): (typeof RELAY_PLATFORMS)[number] {
  return closed(RELAY_PLATFORMS, platform);
}

/** What `POST /relay/update` ended in. The relay answers its refusals with
 * their code as the error; a fetch that got no answer is a `TypeError`. */
export function updateRequestResult(error: unknown): (typeof RELAY_UPDATE_REQUEST_RESULTS)[number] {
  if (error === undefined) return "accepted";
  if (error instanceof TypeError) return "unreachable";
  return closed(RELAY_UPDATE_REQUEST_RESULTS, error instanceof Error ? error.message : undefined);
}

export function installerCode(code: string | undefined): (typeof INSTALLER_CODES)[number] | undefined {
  return code === undefined ? undefined : closed(INSTALLER_CODES, code);
}

export function installerStep(step: string | undefined): (typeof INSTALLER_STEPS)[number] | undefined {
  return step === undefined ? undefined : closed(INSTALLER_STEPS, step);
}

export function updateReason(reason: string | undefined): (typeof RELAY_UPDATE_REASONS)[number] | undefined {
  return reason === undefined ? undefined : closed(RELAY_UPDATE_REASONS, reason);
}

/** Whole seconds since `startedAt`, within what the registry accepts. */
export function secondsSince(startedAt: number, now: number): number {
  return Math.min(24 * 3600, Math.max(0, Math.round((now - startedAt) / 1000)));
}
