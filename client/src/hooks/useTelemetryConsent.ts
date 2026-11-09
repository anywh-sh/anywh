import { useSyncExternalStore } from "react";
import type { ConsentState } from "@/lib/telemetry/consent";
import { telemetry } from "@/lib/telemetry";

export interface TelemetryConsent {
  state: ConsentState;
  /** Whether this build can send at all: no key, no analytics. */
  available: boolean;
  /** The first-launch banner is up exactly while this is true. */
  bannerVisible: boolean;
  /** What the switch shows: sending is on right now. */
  enabled: boolean;
  /** The environment forbids sending, whatever the saved choice says. */
  lockedByEnv: boolean;
  accept: () => void;
  decline: (source: "banner" | "settings") => void;
}

/** Reactive read of the telemetry consent — same read-outside-React,
 * subscribe-from-a-hook shape as `useFirstRun`. */
export function useTelemetryConsent(): TelemetryConsent {
  const state = useSyncExternalStore(
    (listener) => telemetry.subscribe(listener),
    () => telemetry.consentState(),
  );
  return {
    state,
    available: telemetry.available,
    bannerVisible: telemetry.available && state === "pending_banner",
    // Pending-while-the-environment-is-read counts as on for a saved yes: the
    // switch should not flicker off at startup.
    enabled: state === "enabled",
    lockedByEnv: state === "disabled_by_env",
    accept: () => telemetry.optIn(),
    decline: (source) => telemetry.optOut(source),
  };
}
