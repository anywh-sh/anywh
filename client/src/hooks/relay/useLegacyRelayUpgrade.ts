import { useCallback, useEffect, useSyncExternalStore } from "react";
import { APP_VERSION } from "@/lib/install/appVersion";
import { BrewUpgradeError, localInstallPossible, upgradeBrewRelay } from "@/lib/install/localRelay";
import { currentPlatform } from "@/lib/platform/platform";
import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { getHostInfo } from "@/lib/relay/filesClient";
import {
  BREW_UPGRADE_STEPS,
  closeUpgradeTerminal,
  findBusySessions,
  legacyUpgradeKind,
  type LegacyUpgradeKind,
  needsLegacyUpgrade,
  NOTHING_NEWER_EXIT,
  runInRelayTerminal,
  upgradeCommand,
} from "@/lib/relay/legacyRelayUpgrade";
import { fetchSessions } from "@/lib/relay/relayClient";

/** The command for the relay's machine, for when the app cannot run it:
 * install, then restart every profile's relay there (they share the tree). */
export const MANUAL_UPGRADE_COMMAND = "curl -fsSL https://anywh.sh/install | sh -s -- --relay-only && systemctl --user restart 'anywh-relay@*'";
export const MANUAL_BREW_COMMAND = BREW_UPGRADE_STEPS;

/** Why an update stopped, each with its own sentence in the dictionary. */
export type LegacyUpgradeFailure =
  /** No relay installed from a release answers on that machine's port. */
  | "not_installed"
  /** The installer failed one of its steps (`detail` is its own words). */
  | "installer"
  /** The relay's terminal could not run it (no tmux there, connection lost). */
  | "terminal"
  /** It ran, but the relay did not come back on the new version. */
  | "not_back"
  /** Conversations kept running past the wait. */
  | "still_busy"
  /** A platform the app has no command for. */
  | "unsupported"
  /** The app ran Homebrew on this Mac, and it failed or couldn't start
   * (`detail` is Homebrew's own words). */
  | "homebrew"
  /** The app ran Homebrew on this Mac, and stopped it at its limit. */
  | "timed_out"
  /** Homebrew on this Mac was already updating or installing the relay. */
  | "already_running";

export type LegacyUpgradeState =
  | { phase: "hidden" }
  | { phase: "available" }
  | { phase: "checking" }
  | { phase: "waiting"; busy: number }
  | { phase: "updating" }
  | { phase: "restarting" }
  | { phase: "done" }
  /** Homebrew has no newer relay yet (its tap follows stable releases, and
   * can be behind the app): nothing was upgraded or restarted. */
  | { phase: "not_published" }
  | { phase: "failed"; reason: LegacyUpgradeFailure; detail?: string; command: string };

export interface LegacyUpgradeTiming {
  /** Between two checks for conversations still running. */
  readonly busyPollMs: number;
  /** How long to wait for them before giving up. */
  readonly busyTimeoutMs: number;
  /** Between two checks for the relay's new version after the restart. */
  readonly versionPollMs: number;
  /** How long the restart may take (the old relay waits for turns first). */
  readonly restartTimeoutMs: number;
}

const DEFAULT_TIMING: LegacyUpgradeTiming = { busyPollMs: 5000, busyTimeoutMs: 15 * 60 * 1000, versionPollMs: 3000, restartTimeoutMs: 6 * 60 * 1000 };

class Failed extends Error {
  constructor(
    readonly reason: LegacyUpgradeFailure,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/** Homebrew had no newer relay to install: not a failure, and nothing was
 * restarted. */
class NotPublished extends Error {}

// Once Homebrew had nothing newer for a relay, the notice stays closed for
// a while on the next launches too (the profile's settings and the bots
// section still offer the update): the tap only catches up once a stable
// release is published, and until then the notice could only end the same
// way every time. Kept per profile, for that relay and app version only.
const NOT_PUBLISHED_KEY = "anywh:relay-upgrade-not-published";
export const NOT_PUBLISHED_QUIET_MS = 12 * 60 * 60 * 1000;
type NotPublishedMarks = Record<string, { relay: string; app: string; at: number }>;

function readNotPublished(): NotPublishedMarks {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOT_PUBLISHED_KEY) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as NotPublishedMarks) : {};
  } catch {
    return {};
  }
}

function writeNotPublished(profileId: string, mark: NotPublishedMarks[string] | null): void {
  const marks = readNotPublished();
  if (mark) marks[profileId] = mark;
  else delete marks[profileId];
  try {
    localStorage.setItem(NOT_PUBLISHED_KEY, JSON.stringify(marks));
  } catch {
    // No storage: the notice comes back on the next launch, as before.
  }
}

/** Whether Homebrew had nothing newer for this relay and app version
 * recently enough that the notice should not offer it again yet. */
export function recentlyNotPublished(profileId: string, relayVersion: string | undefined, appVersion: string, now = Date.now()): boolean {
  const mark = readNotPublished()[profileId] as NotPublishedMarks[string] | undefined;
  return mark !== undefined && mark.relay === relayVersion && mark.app === appVersion && now - mark.at < NOT_PUBLISHED_QUIET_MS;
}

// One update per profile, shared by every place that shows it (the notice,
// the profile's settings, the bots section): they all show the same state
// and start the same run, never two at once.
interface Entry {
  state: LegacyUpgradeState;
  listeners: Set<() => void>;
  /** Where this profile's relay was last asked whether it needs this. */
  checked?: string;
  platform?: string;
  /** How the app can update it (`legacyUpgradeKind`). */
  kind?: LegacyUpgradeKind;
  version?: string;
  /** The run in progress, if any: a run that is no longer this one (called
   * off, or replaced) stops at its next step. */
  run?: symbol;
  /** The notice above the conversation was closed; the other places that
   * offer the update still do. */
  noticeDismissed: boolean;
}
const entries = new Map<string, Entry>();

function entryFor(profileId: string): Entry {
  let entry = entries.get(profileId);
  if (!entry) {
    entry = { state: { phase: "hidden" }, listeners: new Set(), noticeDismissed: false };
    entries.set(profileId, entry);
  }
  return entry;
}

function setState(profileId: string, state: LegacyUpgradeState): void {
  const entry = entryFor(profileId);
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

/** For tests: forget every profile's update. */
export function resetLegacyRelayUpgrades(): void {
  entries.clear();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether the relay is a Homebrew one on this very Mac, so the app itself
 * can upgrade it: its update is Homebrew's, the profile reaches it on
 * loopback, and this is the desktop app on macOS (a browser has no shell). */
export function runsHomebrewRelayHere(profile: Pick<Profile, "host">, kind: LegacyUpgradeKind | undefined): boolean {
  return kind === "homebrew" && LOOPBACK_HOSTS.has(profile.host) && currentPlatform() === "macos" && localInstallPossible();
}

/** The failure the app's own Homebrew run ended in. */
function brewFailure(error: unknown): Failed | NotPublished {
  if (!(error instanceof BrewUpgradeError)) return new Failed("homebrew", error instanceof Error ? error.message : String(error));
  switch (error.code) {
    case "nothing_newer":
      return new NotPublished();
    case "unsupported_platform":
      return new Failed("unsupported");
    case "busy":
      return new Failed("already_running");
    case "timeout":
      return new Failed("timed_out");
    case "spawn_failed":
    case "failed":
      return new Failed("homebrew", error.detail);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const running = (state: LegacyUpgradeState): boolean => ["checking", "waiting", "updating", "restarting"].includes(state.phase);

async function runUpgrade(profile: Profile, appVersion: string, timing: LegacyUpgradeTiming): Promise<void> {
  const entry = entryFor(profile.id);
  const manual = entry.kind === "homebrew" ? MANUAL_BREW_COMMAND : MANUAL_UPGRADE_COMMAND;
  const run = Symbol("legacy-relay-upgrade");
  entry.run = run;
  entry.noticeDismissed = false;
  const cancelled = (): boolean => entry.run !== run;
  // The terminal the update ran in, to close once it is over (none when the
  // app ran Homebrew itself).
  let terminalSession: string | undefined;
  try {
    setState(profile.id, { phase: "checking" });
    const waitUntil = Date.now() + timing.busyTimeoutMs;
    for (;;) {
      const busy = await findBusySessions(profile);
      if (cancelled()) return;
      if (busy.length === 0) break;
      if (Date.now() > waitUntil) throw new Failed("still_busy");
      setState(profile.id, { phase: "waiting", busy: busy.length });
      await sleep(timing.busyPollMs);
      if (cancelled()) return;
    }

    setState(profile.id, { phase: "updating" });
    if (runsHomebrewRelayHere(profile, entry.kind)) {
      // The relay is on this Mac, where its own terminal cannot run anything
      // (it needs tmux; a stock Mac has none) — and the app is already here.
      await upgradeBrewRelay().catch((error: unknown) => {
        throw brewFailure(error);
      });
    } else {
      const command = upgradeCommand({ platform: entry.platform ?? "", port: profile.relayPort, version: appVersion });
      if (!command) throw new Failed("unsupported");
      const { host, port, token } = await resolveConnection(profile);
      terminalSession = (await fetchSessions(host, port, token))[0]?.id ?? "default";
      const outcome = await runInRelayTerminal(profile, terminalSession, command).catch(() => {
        throw new Failed("terminal");
      });
      if (outcome.exitCode === 3) throw new Failed("not_installed");
      if (entry.kind === "homebrew" && outcome.exitCode === NOTHING_NEWER_EXIT) throw new NotPublished();
      if (outcome.exitCode !== 0) throw new Failed("installer", outcome.failure);
    }

    setState(profile.id, { phase: "restarting" });
    const deadline = Date.now() + timing.restartTimeoutMs;
    for (;;) {
      const version = await getHostInfo(profile).then(
        (info) => info.version ?? null,
        () => null,
      );
      // Homebrew installs whatever its formula names, not a version of ours
      // to pick: a different one is the update having happened.
      if (entry.kind === "homebrew" ? version !== null && version !== entry.version : version === appVersion) break;
      if (Date.now() > deadline) throw new Failed("not_back");
      await sleep(timing.versionPollMs);
    }
    if (terminalSession !== undefined) await closeUpgradeTerminal(profile, terminalSession);
    if (cancelled()) return;
    entry.run = undefined;
    writeNotPublished(profile.id, null);
    setState(profile.id, { phase: "done" });
  } catch (error) {
    if (cancelled()) return;
    entry.run = undefined;
    if (error instanceof NotPublished) {
      if (terminalSession !== undefined) await closeUpgradeTerminal(profile, terminalSession);
      if (entry.version !== undefined) writeNotPublished(profile.id, { relay: entry.version, app: appVersion, at: Date.now() });
      setState(profile.id, { phase: "not_published" });
      return;
    }
    const failure = error instanceof Failed ? error : new Failed("terminal");
    setState(profile.id, { phase: "failed", reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}), command: manual });
  }
}

/**
 * The one update a relay from before self-update needs, behind a single
 * button: `start` checks that no conversation on that relay has a turn
 * running (and waits while one does, up to a limit), runs the installer and
 * the restart on the relay's machine through the relay's own terminal, and
 * waits for it to come back on the new release. From then on it updates
 * itself (useRelayAutoUpdate). `dismiss` closes the notice (and calls off a
 * run that is still checking or waiting, never one already updating); the
 * update stays offered in the profile's settings and the bots section.
 */
export function useLegacyRelayUpgrade(
  profile: Profile,
  options: { appVersion?: string; timing?: Partial<LegacyUpgradeTiming> } = {},
): { state: LegacyUpgradeState; noticeDismissed: boolean; relayVersion?: string; eachTime: boolean; start: () => void; dismiss: () => void } {
  const appVersion = options.appVersion ?? APP_VERSION;
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(profile.id);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [profile.id],
  );
  const state = useSyncExternalStore(subscribe, () => entryFor(profile.id).state);

  // A paid (tailnet) profile's relay is the service's to keep current.
  const eligible = !isTailnetProfile(profile);
  const where = `${profile.host}:${String(profile.relayPort)}|${appVersion}`;
  useEffect(() => {
    if (!eligible) return;
    const entry = entryFor(profile.id);
    if (entry.checked === where) return;
    entry.checked = where;
    getHostInfo(profile).then(
      (info) => {
        if (entry.checked !== where || running(entry.state)) return;
        if (!needsLegacyUpgrade(info, appVersion)) {
          // The profile now points at a relay that needs nothing (edited to
          // another host, or updated by hand): whatever was offered for the
          // old one must not be run against it — it could be a downgrade.
          entry.platform = undefined;
          entry.kind = undefined;
          entry.version = undefined;
          if (entry.state.phase !== "hidden") setState(profile.id, { phase: "hidden" });
          return;
        }
        entry.platform = info.platform;
        entry.kind = legacyUpgradeKind(info) ?? undefined;
        entry.version = info.version;
        if (entry.state.phase === "hidden" || entry.state.phase === "done" || entry.state.phase === "failed") {
          if (recentlyNotPublished(profile.id, info.version, appVersion)) entry.noticeDismissed = true;
          setState(profile.id, { phase: "available" });
        }
      },
      // Unreachable now: asked again the next time this mounts.
      () => (entry.checked = undefined),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, where, eligible]);

  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const start = useCallback(() => {
    if (running(entryFor(profile.id).state)) return;
    void runUpgrade(profile, appVersion, timing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, appVersion]);

  const dismiss = useCallback(() => {
    const entry = entryFor(profile.id);
    if (entry.state.phase === "updating" || entry.state.phase === "restarting") return;
    // Closing the notice calls off a run that is only checking or waiting,
    // and hides the notice alone: settings and the bots section still offer
    // the update.
    entry.noticeDismissed = true;
    if (entry.state.phase === "checking" || entry.state.phase === "waiting") {
      entry.run = undefined;
      setState(profile.id, { phase: "available" });
    } else {
      // A new object even when the phase stays: what renders is the store's
      // snapshot, and an unchanged one would leave the notice on screen.
      setState(profile.id, entry.state.phase === "done" ? { phase: "hidden" } : { ...entry.state });
    }
  }, [profile.id]);

  const entry = entryFor(profile.id);
  // A Homebrew relay never updates itself, on this Mac or another: the
  // update is offered again with every release, and the notice must not
  // promise otherwise. Only the installer's relay keeps itself up to date
  // after this one update.
  const eachTime = entry.kind === "homebrew";
  return { state, noticeDismissed: entry.noticeDismissed, relayVersion: entry.version, eachTime, start, dismiss };
}
