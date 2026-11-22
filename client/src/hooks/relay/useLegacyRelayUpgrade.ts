import { useCallback, useEffect, useSyncExternalStore } from "react";
import { APP_VERSION } from "@/lib/install/appVersion";
import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { getHostInfo } from "@/lib/relay/filesClient";
import { closeUpgradeTerminal, findBusySessions, needsLegacyUpgrade, runInRelayTerminal, upgradeCommand } from "@/lib/relay/legacyRelayUpgrade";
import { fetchSessions } from "@/lib/relay/relayClient";

/** The command for the relay's machine, for when the app cannot run it:
 * install, then restart every profile's relay there (they share the tree). */
export const MANUAL_UPGRADE_COMMAND = "curl -fsSL https://anywh.sh/install | sh -s -- --relay-only && systemctl --user restart 'anywh-relay@*'";
export const MANUAL_BREW_COMMAND = "brew upgrade anywh-relay && brew services restart anywh-relay";

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
  | "unsupported";

export type LegacyUpgradeState =
  | { phase: "hidden" }
  | { phase: "available" }
  | { phase: "checking" }
  | { phase: "waiting"; busy: number }
  | { phase: "updating" }
  | { phase: "restarting" }
  | { phase: "done" }
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

// One update per profile, shared by every place that shows it (the notice,
// the profile's settings, the bots section): they all show the same state
// and start the same run, never two at once.
interface Entry {
  state: LegacyUpgradeState;
  listeners: Set<() => void>;
  /** Where this profile's relay was last asked whether it needs this. */
  checked?: string;
  platform?: string;
  version?: string;
  cancelled?: boolean;
}
const entries = new Map<string, Entry>();

function entryFor(profileId: string): Entry {
  let entry = entries.get(profileId);
  if (!entry) {
    entry = { state: { phase: "hidden" }, listeners: new Set() };
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const running = (state: LegacyUpgradeState): boolean => ["checking", "waiting", "updating", "restarting"].includes(state.phase);

async function runUpgrade(profile: Profile, appVersion: string, timing: LegacyUpgradeTiming): Promise<void> {
  const entry = entryFor(profile.id);
  const manual = entry.platform === "darwin" ? MANUAL_BREW_COMMAND : MANUAL_UPGRADE_COMMAND;
  entry.cancelled = false;
  let terminalSession: string;
  try {
    setState(profile.id, { phase: "checking" });
    const waitUntil = Date.now() + timing.busyTimeoutMs;
    for (;;) {
      const busy = await findBusySessions(profile);
      if (entry.cancelled) return;
      if (busy.length === 0) break;
      if (Date.now() > waitUntil) throw new Failed("still_busy");
      setState(profile.id, { phase: "waiting", busy: busy.length });
      await sleep(timing.busyPollMs);
      if (entry.cancelled) return;
    }

    setState(profile.id, { phase: "updating" });
    const command = upgradeCommand({ platform: entry.platform ?? "", port: profile.relayPort, version: appVersion });
    if (!command) throw new Failed("unsupported");
    const { host, port, token } = await resolveConnection(profile);
    terminalSession = (await fetchSessions(host, port, token))[0]?.id ?? "default";
    const outcome = await runInRelayTerminal(profile, terminalSession, command).catch(() => {
      throw new Failed("terminal");
    });
    if (outcome.exitCode === 3) throw new Failed("not_installed");
    if (outcome.exitCode !== 0) throw new Failed("installer", outcome.failure);

    setState(profile.id, { phase: "restarting" });
    const deadline = Date.now() + timing.restartTimeoutMs;
    for (;;) {
      const version = await getHostInfo(profile).then(
        (info) => info.version ?? null,
        () => null,
      );
      // Homebrew installs whatever its formula names, not a version of ours
      // to pick: a different one is the update having happened.
      if (entry.platform === "darwin" ? version !== null && version !== entry.version : version === appVersion) break;
      if (Date.now() > deadline) throw new Failed("not_back");
      await sleep(timing.versionPollMs);
    }
    await closeUpgradeTerminal(profile, terminalSession);
    setState(profile.id, { phase: "done" });
  } catch (error) {
    if (entry.cancelled) return;
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
 * itself (useRelayAutoUpdate). `dismiss` hides the notice, and cancels a
 * run that is still checking or waiting (never one already updating).
 */
export function useLegacyRelayUpgrade(
  profile: Profile,
  options: { appVersion?: string; timing?: Partial<LegacyUpgradeTiming> } = {},
): { state: LegacyUpgradeState; relayVersion?: string; start: () => void; dismiss: () => void } {
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
        if (!needsLegacyUpgrade(info, appVersion)) return;
        entry.platform = info.platform;
        entry.version = info.version;
        if (entry.state.phase === "hidden") setState(profile.id, { phase: "available" });
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
    entry.cancelled = true;
    setState(profile.id, { phase: "hidden" });
  }, [profile.id]);

  return { state, relayVersion: entryFor(profile.id).version, start, dismiss };
}
