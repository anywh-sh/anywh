import { getProfiles } from "@/lib/profiles/profiles";
import { isFirstRunActive } from "@/lib/profiles/firstRun";
import { isPushActive } from "@/lib/platform/pushRegistration";
import { readSettings } from "@/lib/settings";
import { readFontSize, DEFAULT_FONT_SIZE } from "@/lib/fontSize";
import { isBuiltinTheme } from "@/lib/theme/builtinThemes";
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
  type PromptTarget,
  type UpgradePromptSource,
  type BotAction,
  type BotCreateFailure,
  type BotCreateSource,
  type EventProps,
} from "@/lib/telemetry/events";
import { APP_VERSION } from "@/lib/install/appVersion";
import { getInstallOrigin, resolveUpdateMode } from "@/lib/install/updateMode";
import type { Profile } from "@/lib/profiles/profiles";
import { LOOPBACK_HOSTS } from "@/lib/profiles/loopback";
import type { HostInfo } from "@/lib/relay/filesClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { botsSnapshot, templateKind } from "@/lib/telemetry/bots";
import { relayPlatform, relayUpdatePath, relayVsApp, updateRequestResult, installerCode, installerStep, secondsSince, updateReason, versionOrNone } from "@/lib/telemetry/relay";

/**
 * The call sites' vocabulary. Each function takes what the app already has
 * (an agent id, a profile, a screen) and reduces it to the registry's closed
 * values, so no call site builds a payload by hand and none can pass free
 * text. Anything that does not fit a closed list becomes `other`.
 */

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

export function trackPromptSent(agentId: string | null | undefined, target: PromptTarget = "chat"): void {
  telemetry.trackDaily(`prompt:${target}`, "prompt_sent", { target, runtime: runtimeOf(agentId) });
  const now = Date.now();
  telemetry.trackOnce("first_prompt_sent", "first_prompt_sent", {
    seconds_since_first_open: Math.max(0, Math.round((now - firstOpenAt(now)) / 1000)),
    runtime: runtimeOf(agentId),
  });
}

/** A profile whose relay runs on this machine: installed here by the app,
 * or reached on loopback without the broker. */
function isLocalProfile(profile: Pick<Profile, "host" | "localRelay" | "brokerNodeId">): boolean {
  return profile.localRelay === true || (!profile.brokerNodeId && LOOPBACK_HOSTS.has(profile.host));
}

export function trackProfileAdded(profile: Pick<Profile, "host" | "localRelay" | "brokerNodeId">): void {
  const local = isLocalProfile(profile);
  telemetry.track("profile_added", local ? { kind: "local" } : { kind: "remote", pairing_method: profile.brokerNodeId ? "code" : "address" });
}

export function trackProfileConnectFailed(input: Omit<EventProps<"profile_connect_failed">, "in_first_run">): void {
  telemetry.track("profile_connect_failed", { ...input, in_first_run: isFirstRunActive() });
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
  const local = profile?.localRelay === true || (profile !== undefined && !profile.brokerNodeId && LOOPBACK_HOSTS.has(profile.host));
  const flow = firstRunFlow;
  firstRunFlow = null;
  const agents = [...new Set(agentIds.map(agentIdOf).filter((id): id is NonNullable<typeof id> => id !== null))];
  telemetry.track("first_run_completed", {
    path: flow ?? (local ? (profile?.localRelay ? "local_install" : "adopt") : "remote"),
    duration_s: Math.max(0, Math.round((Date.now() - started) / 1000)),
    agents_installed: agents,
  });
}

/** Once a day per profile, from the relay's own `/host-info`: the release
 * it runs against the app's, and the way it gets updated. The profile id is
 * only the dedupe key, kept on this device. */
export function trackRelaySeen(profile: Pick<Profile, "id" | "host" | "localRelay" | "brokerNodeId">, info: HostInfo, appVersion: string = APP_VERSION): void {
  const relayVersion = versionOrNone(info.version);
  telemetry.trackDaily(`relay_seen:${profile.id}`, "relay_seen", {
    ...(relayVersion !== undefined ? { relay_version: relayVersion } : {}),
    vs_app: relayVsApp(info.version, appVersion),
    update_path: relayUpdatePath(info),
    platform: relayPlatform(info.platform),
    profile_kind: isLocalProfile(profile) ? "local" : "remote",
    has_bots: info.features?.includes("bots") === true,
  });
}

/** What `POST /relay/update` ended in; `error` absent when it was taken. */
export function trackRelayUpdateRequested(fromVersion: string | undefined, toVersion: string, error?: unknown): void {
  const from = versionOrNone(fromVersion);
  const to = versionOrNone(toVersion);
  if (from === undefined || to === undefined) return;
  telemetry.track("relay_update_requested", { from_version: from, to_version: to, result: updateRequestResult(error) });
}

export interface RelayUpdateEnd {
  path: EventProps<"relay_update_finished">["path"];
  outcome: EventProps<"relay_update_finished">["outcome"];
  reason?: string;
  installerCode?: string;
  installerStep?: string;
  lastState?: EventProps<"relay_update_finished">["last_state"];
  fromVersion?: string;
  toVersion: string;
  startedAt: number;
}

/** How an update the app started ended. A failure is also a visible error.
 * `onceKey` reports it at most once for that key ever: the relay's own
 * update keeps its failure until it is asked again, so the app can read
 * the same one on more than one launch. */
export function trackRelayUpdateFinished(end: RelayUpdateEnd, onceKey?: string): void {
  const to = versionOrNone(end.toVersion);
  if (to === undefined) return;
  const from = versionOrNone(end.fromVersion);
  const reason = updateReason(end.reason);
  const code = installerCode(end.installerCode);
  const step = installerStep(end.installerStep);
  const props: EventProps<"relay_update_finished"> = {
    path: end.path,
    outcome: end.outcome,
    ...(reason !== undefined ? { reason } : {}),
    ...(code !== undefined ? { installer_code: code } : {}),
    ...(step !== undefined ? { installer_step: step } : {}),
    ...(end.lastState !== undefined ? { last_state: end.lastState } : {}),
    ...(from !== undefined ? { from_version: from } : {}),
    to_version: to,
    duration_s: secondsSince(end.startedAt, Date.now()),
  };
  const result = onceKey === undefined ? telemetry.track("relay_update_finished", props) : telemetry.trackOnce(onceKey, "relay_update_finished", props);
  if (end.outcome === "failed" && result !== "dropped") trackError("relay_update_failed");
}

/** The offer to update a relay by hand: `shown` once a day per profile and
 * place, `clicked` and `dismissed` each time. */
export function trackRelayUpgradePrompt(
  profileId: string,
  action: EventProps<"relay_upgrade_prompt">["action"],
  kind: EventProps<"relay_upgrade_prompt">["kind"],
  source: UpgradePromptSource,
): void {
  const props = { action, kind, source };
  if (action === "shown") telemetry.trackDaily(`upgrade_prompt:${profileId}:${source}`, "relay_upgrade_prompt", props);
  else telemetry.track("relay_upgrade_prompt", props);
}

export function trackBotCreateOpened(source: BotCreateSource, templateId: string | undefined): void {
  telemetry.track("bot_create_opened", { source, template: templateKind(templateId) });
}

export interface BotCreateAttempt {
  templateId: string | undefined;
  openedAt: number;
  gated: boolean;
  failedAttempts: number;
  lastFailure?: BotCreateFailure;
  created?: { agentId: string; scheduleOn: boolean };
}

export function trackBotCreateEnded(attempt: BotCreateAttempt): void {
  telemetry.track("bot_create_ended", {
    outcome: attempt.created ? "created" : "abandoned",
    template: templateKind(attempt.templateId),
    ...(attempt.created ? { runtime: runtimeOf(attempt.created.agentId) } : {}),
    schedule_on: attempt.created?.scheduleOn === true,
    gated: attempt.gated,
    failed_attempts: Math.min(10, attempt.failedAttempts),
    ...(attempt.lastFailure ? { last_failure: attempt.lastFailure } : {}),
    duration_s: secondsSince(attempt.openedAt, Date.now()),
  });
}

/** What a person did with a bot, once a day per kind of action. */
export function trackBotAction(action: BotAction): void {
  telemetry.trackDaily(`bot_action:${action}`, "bot_action", { action });
}

/** Once a day per profile, the first time its relay's bots are known. */
export function trackBotsSnapshot(profileId: string, bots: readonly BotSummary[]): void {
  telemetry.trackDaily(`bots_snapshot:${profileId}`, "bots_snapshot", botsSnapshot(bots));
}

/** `custom` only for an imported theme: any built-in, the default or not, and
 * a selection whose file is gone (it renders as the default) are `builtin`. */
export function themeKind(): "builtin" | "custom" {
  const id = getSelectedThemeId();
  if (id === null || isBuiltinTheme(id) || resolveSelectedTheme().missing) return "builtin";
  return "custom";
}

/** Once the app is up: `app_opened`, today's `app_active` and, on the first
 * boot of a new version, `update_installed`. Held by the controller until the
 * consent question is answered. */
export async function reportBoot(): Promise<void> {
  if (!telemetry.available) return;
  const profiles = getProfiles();
  const local = profiles.filter((p) => p.localRelay === true).length;
  // The mode that runs, not the stored one: an unset value is automatic on an
  // install that can replace itself. iOS has no origin probe, hence the catch.
  const updatable = await getInstallOrigin().then(
    (origin) => origin.updatable,
    () => false,
  );
  const mode = updateModeOf(resolveUpdateMode(readSettings().app?.updateMode, updatable));
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
    theme_kind: themeKind(),
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
