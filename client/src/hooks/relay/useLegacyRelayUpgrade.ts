import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalRelayProbe } from "@/hooks/platform/useLocalRelayProbe";
import { APP_VERSION } from "@/lib/install/appVersion";
import { updateLocalRelay } from "@/lib/install/localRelayUpdate";
import { currentPlatform } from "@/lib/platform/platform";
import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";
import {
  closeUpgradeTerminal,
  findBusySessions,
  needsLegacyUpgrade,
  runInRelayTerminal,
  upgradeCommand,
} from "@/lib/relay/legacyRelayUpgrade";
import { fetchSessions } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";

/** The command for the relay's machine, for when the app cannot run it. */
export const MANUAL_UPGRADE_COMMAND = "curl -fsSL https://anywh.sh/install | sh -s -- --relay-only";

export type LegacyUpgradeState =
  | { phase: "hidden" }
  | { phase: "available" }
  | { phase: "checking" }
  | { phase: "waiting"; busy: number }
  | { phase: "updating" }
  | { phase: "restarting" }
  | { phase: "done" }
  | { phase: "failed"; error: string | null; command: string };

export interface LegacyUpgradeTiming {
  /** Between two checks for conversations still running. */
  readonly busyPollMs: number;
  /** Between two checks for the relay's new version after the restart. */
  readonly versionPollMs: number;
  /** How long the restart may take (the old relay waits for turns first). */
  readonly restartTimeoutMs: number;
}

const DEFAULT_TIMING: LegacyUpgradeTiming = { busyPollMs: 5000, versionPollMs: 3000, restartTimeoutMs: 6 * 60 * 1000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The one update a relay from before self-update needs, behind a single
 * button: `start` checks that no conversation on that relay has a turn
 * running (and waits while one does), updates it — through the in-app
 * installer for a relay on this Linux machine, through the relay's own
 * terminal anywhere else — and waits for it to come back on the new
 * release. From then on it updates itself (useRelayAutoUpdate).
 */
export function useLegacyRelayUpgrade(
  profile: Profile,
  options: { appVersion?: string; timing?: Partial<LegacyUpgradeTiming> } = {},
): { state: LegacyUpgradeState; start: () => void; dismiss: () => void } {
  const appVersion = options.appVersion ?? APP_VERSION;
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const timingRef = useRef(timing);
  timingRef.current = timing;
  const probe = useLocalRelayProbe();
  const [state, setState] = useState<LegacyUpgradeState>({ phase: "hidden" });
  const [platform, setPlatform] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const alive = useRef(true);
  const unlisten = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
      unlisten.current?.();
    },
    [],
  );

  // A paid (tailnet) profile's relay is the service's to keep current.
  const eligible = !isTailnetProfile(profile);
  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    getHostInfo(profile).then(
      (info) => {
        if (cancelled || !needsLegacyUpgrade(info, appVersion)) return;
        setPlatform(info.platform);
        setBefore(info.version ?? null);
        setState({ phase: "available" });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.host, profile.relayPort, appVersion, eligible]);

  const localInApp = profile.host === "127.0.0.1" && probe?.installedVersion != null && currentPlatform() === "linux";
  // One paste on the relay's machine: install, then restart onto it.
  const manual =
    platform === "darwin"
      ? "brew upgrade anywh-relay && brew services restart anywh-relay"
      : `${MANUAL_UPGRADE_COMMAND} && systemctl --user restart anywh-relay@${profile.id}`;

  const start = useCallback(() => {
    const set = (next: LegacyUpgradeState): void => {
      if (alive.current) setState(next);
    };
    void (async () => {
      try {
        set({ phase: "checking" });
        for (;;) {
          const busy = await findBusySessions(profile);
          if (!alive.current) return;
          if (busy.length === 0) break;
          set({ phase: "waiting", busy: busy.length });
          await sleep(timingRef.current.busyPollMs);
        }

        set({ phase: "updating" });
        let terminalSession: string | null = null;
        if (localInApp) {
          const registered = probe?.profiles.find((p) => p.id === profile.id);
          await updateLocalRelay(profile, registered?.homeOverride ?? undefined, (remove) => (unlisten.current = remove));
        } else {
          const command = upgradeCommand({ platform: platform ?? "", profileId: profile.id, version: appVersion });
          if (!command) throw new Error("this relay runs on a platform the app cannot update it on");
          const { host, port, token } = await resolveConnection(profile);
          terminalSession = (await fetchSessions(host, port, token))[0]?.id ?? "default";
          const outcome = await runInRelayTerminal(profile, terminalSession, command);
          if (outcome.exitCode !== 0) throw new Error(outcome.failure ?? `exit ${String(outcome.exitCode)}`);
        }

        set({ phase: "restarting" });
        const deadline = Date.now() + timingRef.current.restartTimeoutMs;
        for (;;) {
          const version = await getHostInfo(profile).then(
            (info) => info.version ?? null,
            () => null,
          );
          if (!alive.current) return;
          // Homebrew installs whatever its formula names, not a version of
          // ours to pick: a different one is the update having happened.
          if (platform === "darwin" ? version !== null && version !== before : version === appVersion) break;
          if (Date.now() > deadline) throw new Error("the relay did not come back on the new version");
          await sleep(timingRef.current.versionPollMs);
        }
        if (terminalSession) await closeUpgradeTerminal(profile, terminalSession);
        set({ phase: "done" });
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : null;
        set({ phase: "failed", error: message, command: manual });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, localInApp, platform, appVersion, before, manual, probe]);

  const dismiss = useCallback(() => setState({ phase: "hidden" }), []);
  return { state, start, dismiss };
}
