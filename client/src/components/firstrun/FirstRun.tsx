import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AdvancedOptions } from "@/components/firstrun/AdvancedOptions";
import { AgentsScreen } from "@/components/firstrun/AgentsScreen";
import { CloseDuringInstallDialog } from "@/components/firstrun/CloseDuringInstallDialog";
import { OnboardingFrame } from "@/components/firstrun/OnboardingFrame";
import { OtherMachine } from "@/components/firstrun/OtherMachine";
import { Preparing } from "@/components/firstrun/Preparing";
import { Welcome } from "@/components/firstrun/Welcome";
import { useProfileSetup } from "@/hooks/profiles/useProfileSetup";
import { useProfiles } from "@/hooks/profiles/useProfiles";
import { useDict } from "@/i18n";
import { attachPreviousRun, beginLocalInstall, getLocalInstallState, type BeginLocalInstallOptions } from "@/lib/install/localInstall";
import { localInstallPossible, probeLocalRelay, type LocalRelayProbe } from "@/lib/install/localRelay";
import { getPendingAgentsProfileId } from "@/lib/install/pendingAgents";
import { currentPlatform } from "@/lib/platform/platform";
import { inTauri } from "@/lib/platform/tauri";
import { adoptLocalProfiles, canAdopt, getAdoptState } from "@/lib/profiles/adoptLocal";
import {
  beginFirstRun,
  ensureFirstRunViews,
  getFirstRunViews,
  popFirstRunView,
  pushFirstRunView,
  resetFirstRunViews,
  subscribeFirstRunViews,
  type FirstRunView,
} from "@/lib/profiles/firstRun";
import { findProfile } from "@/lib/profiles/profiles";
import { completeProfileSetup, getProfileSetupState, resumeProfileSetup } from "@/lib/profiles/profileSetup";

function useFirstRunViews(): FirstRunView[] {
  return useSyncExternalStore(subscribeFirstRunViews, getFirstRunViews);
}

/** Windows has no in-app install, but it is still a desktop: it opens on
 * the welcome (with the WSL2 variant), not on "another machine". */
function onWindowsDesktop(): boolean {
  return inTauri() && currentPlatform() === "windows";
}

/**
 * Where the first run opens, in order: an "agents" step left open by a
 * relaunch; a link already connecting; a place with no local path at all
 * (the browser, iOS) on "another machine", with nothing to go back to; and
 * the welcome everywhere else. A run from before (alive or interrupted) is
 * picked up once the probe answers — see the effect below.
 */
function initialViews(): FirstRunView[] {
  const pendingId = getPendingAgentsProfileId();
  const pending = pendingId ? findProfile(pendingId) : undefined;
  if (pending) return [{ screen: "agents", profileId: pending.id, remoteHost: pending.localRelay ? undefined : pending.host }];
  const setup = getProfileSetupState().state;
  if (!localInstallPossible() && !onWindowsDesktop()) return [{ screen: "other" }];
  if (setup && setup.status !== "ready") return [{ screen: "welcome" }, { screen: "other" }];
  return [{ screen: "welcome" }];
}

/**
 * What the window shows instead of the shell while this device has no
 * profile (or has one whose first run isn't over). A container of screens:
 * the welcome, preparing this machine (install or adopt), the agents of the
 * profile just set up, another machine, and the advanced options. Which one
 * is showing — and what "Back" returns to — is a stack in `firstRun.ts`, so
 * a remount mid-install lands on the same screen.
 *
 * Every outcome is drawn inline by the screen that started it; the setup
 * dialog the shell uses for a pairing is not shown here. Leaving (the agents
 * screen's "Start") goes through `finishFirstRun`, and the verified profile's
 * setup is completed on the way out so the next queued link can run.
 */
export function FirstRun() {
  const dict = useDict();
  const copy = dict.firstRun;
  useState(() => ensureFirstRunViews(initialViews));
  const views = useFirstRunViews();
  const setup = useProfileSetup();
  const profiles = useProfiles();
  const [probe, setProbe] = useState<LocalRelayProbe | null>(null);
  const probing = useRef<Promise<LocalRelayProbe | null> | null>(null);
  // Giving up on an adoption means "not these": the next try installs.
  const adoptionDeclined = useRef(false);

  const view = views[views.length - 1] ?? { screen: "welcome" };

  // Every render, not once: `beginFirstRun` is idempotent, and re-asserting
  // it is what keeps the gate closed while this screen is on the window.
  useEffect(() => {
    beginFirstRun();
  });

  // The verified profile's setup stays `ready` while its agents are picked
  // (the queue waits behind it); leaving the first run completes it.
  useEffect(
    () => () => {
      if (getProfileSetupState().state?.status === "ready") completeProfileSetup();
    },
    [],
  );

  // A read of this machine's disk, no network: decides whether "set up"
  // installs or adopts, and picks up a run from an earlier launch where it
  // is — the one case that skips the welcome.
  useEffect(() => {
    if (!localInstallPossible()) return;
    let cancelled = false;
    const promise = probeLocalRelay().catch(() => null);
    probing.current = promise;
    void promise.then((result) => {
      if (cancelled) return;
      setProbe(result);
      const previous = result?.previousRun;
      const onWelcome = getFirstRunViews().every((v) => v.screen === "welcome");
      if (previous && onWelcome && (previous.alive || (!previous.ok && previous.exitCode === null)) && getLocalInstallState().install.status === "idle") {
        void attachPreviousRun(previous);
        resetFirstRunViews([{ screen: "welcome" }, { screen: "preparing", mode: "install" }]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A profile saved by an earlier launch that never got verified: dial it
  // again. One on this machine is picked up by the adoption the welcome
  // leads to; one elsewhere shows its progress on "another machine".
  const soleUnverified = profiles.length === 1 && profiles[0].unverified ? profiles[0] : null;
  useEffect(() => {
    if (!soleUnverified || soleUnverified.localRelay) return;
    resumeProfileSetup(soleUnverified);
    if (getFirstRunViews().every((v) => v.screen === "welcome")) pushFirstRunView({ screen: "other" });
  }, [soleUnverified]);

  // A link that starts connecting while the welcome is showing takes the
  // reader to where its progress is drawn.
  const linkRunning = setup.state !== null && setup.state.status !== "ready" && setup.state.status !== "failed" && view.screen === "welcome";
  useEffect(() => {
    if (linkRunning && getAdoptState().status === "idle" && getLocalInstallState().install.status === "idle") pushFirstRunView({ screen: "other" });
  }, [linkRunning]);

  async function setUpHere(): Promise<void> {
    const result = probe ?? (await probing.current) ?? null;
    if (canAdopt(result) && result && !adoptionDeclined.current) {
      adoptLocalProfiles(result);
      pushFirstRunView({ screen: "preparing", mode: "adopt" });
      return;
    }
    beginLocalInstall({
      label: copy.profile.defaultLabel,
      note: result?.installed && result.supported ? "alreadyInstalled" : "none",
    });
    pushFirstRunView({ screen: "preparing", mode: "install" });
  }

  function installWith(options: BeginLocalInstallOptions): void {
    beginLocalInstall(options);
    resetFirstRunViews([{ screen: "welcome" }, { screen: "preparing", mode: "install" }]);
  }

  function preparedProfileId(mode: "install" | "adopt"): string | null {
    return mode === "adopt" ? getAdoptState().activeId : getLocalInstallState().verify.profileId;
  }

  const back = views.length > 1 ? popFirstRunView : undefined;
  const agentsProfile = view.screen === "agents" ? profiles.find((p) => p.id === view.profileId) : undefined;

  return (
    <>
      {view.screen === "welcome" && (
        <Welcome
          windows={onWindowsDesktop()}
          container={probe?.containerized ?? null}
          onSetUp={() => void setUpHere()}
          onTerminal={() => pushFirstRunView({ screen: "advanced", install: "terminal" })}
          onOtherMachine={() => pushFirstRunView({ screen: "other" })}
        />
      )}
      {view.screen === "preparing" && (
        <Preparing
          mode={view.mode}
          onDone={() => {
            const id = preparedProfileId(view.mode);
            if (id) resetFirstRunViews([{ screen: "agents", profileId: id }]);
          }}
          onCancel={() => {
            if (view.mode === "adopt") adoptionDeclined.current = true;
            resetFirstRunViews([{ screen: "welcome" }]);
          }}
          onTerminal={() => resetFirstRunViews([{ screen: "welcome" }, { screen: "advanced", install: "terminal" }])}
          onOtherMachine={() => resetFirstRunViews([{ screen: "welcome" }, { screen: "other" }])}
        />
      )}
      {view.screen === "agents" && agentsProfile && (
        <AgentsScreen profile={agentsProfile} remoteHost={view.remoteHost} onOtherMachine={() => pushFirstRunView({ screen: "other" })} />
      )}
      {view.screen === "other" && (
        <OnboardingFrame onBack={back}>
          <OtherMachine
            key={`${view.mode ?? "code"}:${view.host ?? ""}:${String(view.port ?? "")}`}
            initialMode={view.mode}
            initialHost={view.host}
            initialPort={view.port}
            onAdvanced={() => pushFirstRunView({ screen: "advanced" })}
            onReady={(ready) =>
              resetFirstRunViews([
                { screen: "agents", profileId: ready.profile.id, remoteHost: ready.profile.host === "127.0.0.1" ? undefined : ready.profile.host },
              ])
            }
          />
        </OnboardingFrame>
      )}
      {view.screen === "advanced" && (
        <OnboardingFrame onBack={back}>
          <AdvancedOptions
            key={view.install ?? "default"}
            initialInstall={view.install}
            onInstall={installWith}
            onConnect={({ host, port }) => pushFirstRunView({ screen: "other", mode: "address", host, port })}
          />
        </OnboardingFrame>
      )}
      <CloseDuringInstallDialog />
    </>
  );
}
