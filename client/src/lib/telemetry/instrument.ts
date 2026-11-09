import { getProfiles } from "@/lib/profiles/profiles";
import { isPushActive } from "@/lib/platform/pushRegistration";
import { readSettings } from "@/lib/settings";
import { readFontSize, DEFAULT_FONT_SIZE } from "@/lib/fontSize";
import { getSelectedThemeId, resolveSelectedTheme } from "@/lib/theme/themes";
import { telemetry } from "@/lib/telemetry";
import { dailyDue, firstOpenAt, swapBootVersion } from "@/lib/telemetry/dedupe";
import {
  agentIdOf,
  effortOf,
  modelFamily,
  permissionModeOf,
  runtimeOf,
  updateModeOf,
  type ErrorKind,
  type Feature,
  type EventProps,
} from "@/lib/telemetry/events";
import { APP_VERSION } from "@/lib/install/appVersion";
import type { Profile } from "@/lib/profiles/profiles";

/**
 * The call sites' vocabulary. Each function takes what the app already has
 * (an agent id, a profile, a screen) and reduces it to the registry's closed
 * values, so no call site builds a payload by hand and none can pass free
 * text. Anything that does not fit a closed list becomes `other`.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function trackFeature(feature: Feature): void {
  telemetry.trackDaily(`feature:${feature}`, "feature_used", { feature });
}

export function trackError(kind: ErrorKind): void {
  telemetry.track("error_shown", { kind });
}

export function trackSessionStarted(input: {
  agentId: string | null | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  permissionMode: string | null | undefined;
  kind: "chat" | "sala";
}): void {
  telemetry.track("session_started", {
    runtime: runtimeOf(input.agentId),
    model_family: modelFamily(input.model),
    effort: effortOf(input.effort),
    permission_mode: permissionModeOf(input.permissionMode),
    kind: input.kind,
  });
}

export function trackPromptSent(agentId: string | null | undefined): void {
  const now = Date.now();
  telemetry.trackOnce("first_prompt_sent", "first_prompt_sent", {
    seconds_since_first_open: Math.max(0, Math.round((now - firstOpenAt(now)) / 1000)),
    runtime: runtimeOf(agentId),
  });
}

export function trackProfileAdded(profile: Pick<Profile, "host" | "localRelay" | "brokerNodeId">): void {
  const local = profile.localRelay === true || (!profile.brokerNodeId && LOOPBACK.has(profile.host));
  telemetry.track("profile_added", local ? { kind: "local" } : { kind: "remote", pairing_method: profile.brokerNodeId ? "code" : "address" });
}

/** The path the person last took in the first run. The profile alone cannot
 * tell it: adopting an existing relay and installing a new one both save a
 * `localRelay` profile. */
let firstRunFlow: EventProps<"first_run_completed">["path"] | null = null;

export function trackFirstRunStep(step: EventProps<"first_run_step_viewed">["step"], mode: EventProps<"first_run_step_viewed">["mode"]): void {
  if (step === "preparing") firstRunFlow = mode === "adopt" ? "adopt" : "local_install";
  else if (step === "other") firstRunFlow = "remote";
  telemetry.track("first_run_step_viewed", mode === undefined ? { step } : { step, mode });
}

let firstRunStartedAt: number | null = null;
export function markFirstRunStarted(): void {
  firstRunStartedAt ??= Date.now();
}

export function trackFirstRunCompleted(profile: Pick<Profile, "host" | "localRelay" | "brokerNodeId"> | undefined, agentIds: readonly string[]): void {
  const started = firstRunStartedAt ?? Date.now();
  firstRunStartedAt = null;
  const local = profile?.localRelay === true || (profile !== undefined && !profile.brokerNodeId && LOOPBACK.has(profile.host));
  const flow = firstRunFlow;
  firstRunFlow = null;
  const agents = [...new Set(agentIds.map(agentIdOf).filter((id): id is NonNullable<typeof id> => id !== null))];
  telemetry.track("first_run_completed", {
    path: flow ?? (local ? (profile?.localRelay ? "local_install" : "adopt") : "remote"),
    duration_s: Math.max(0, Math.round((Date.now() - started) / 1000)),
    agents_installed: agents,
  });
}

/** Once the app is up: `app_opened`, today's `app_active` and, on the first
 * boot of a new version, `update_installed`. Held by the controller until the
 * consent question is answered. */
export function reportBoot(): void {
  if (!telemetry.available) return;
  const profiles = getProfiles();
  const local = profiles.filter((p) => p.localRelay === true).length;
  const mode = updateModeOf(readSettings().app?.updateMode ?? "notify");
  const fontSize = readFontSize();
  const previous = swapBootVersion(APP_VERSION);
  firstOpenAt(Date.now());
  if (previous !== undefined && previous !== APP_VERSION) {
    telemetry.track("update_installed", { from_version: previous, to_version: APP_VERSION, update_mode: mode });
  }
  telemetry.track("app_opened", {
    profile_count: profiles.length,
    local_profiles: local,
    remote_profiles: profiles.length - local,
    // Agents this device has seen a profile use: the installed set itself is
    // only known to each relay, and the app does not poll them for this.
    runtimes_installed: [...new Set(profiles.map((p) => agentIdOf(p.lastUsedAgentId ?? "")).filter((id): id is NonNullable<typeof id> => id !== null))],
    update_mode: mode,
    push_enabled: profiles.some((p) => isPushActive(p.id)),
    theme_kind: getSelectedThemeId() === null || resolveSelectedTheme().missing ? "builtin" : "custom",
    font_size_bucket: fontSize < DEFAULT_FONT_SIZE ? "small" : fontSize > DEFAULT_FONT_SIZE ? "large" : "default",
  });
  const active = (): void => {
    telemetry.trackDaily("app_active", "app_active", {});
  };
  active();
  // An app left open past midnight is active on the next day too.
  setInterval(() => {
    if (dailyDue("app_active", Date.now())) active();
  }, 30 * 60_000);
}
