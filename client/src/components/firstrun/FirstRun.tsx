import { useEffect, useState } from "react";
import { AdoptScreen } from "@/components/firstrun/AdoptScreen";
import { CloseDuringInstallDialog } from "@/components/firstrun/CloseDuringInstallDialog";
import { ConnectExistingMachine } from "@/components/firstrun/ConnectExistingMachine";
import { DetectScreen } from "@/components/firstrun/DetectScreen";
import { FirstRunHome, type LocalPathAvailability } from "@/components/firstrun/FirstRunHome";
import { LocalInstall } from "@/components/firstrun/LocalInstall";
import { ManualInstructions } from "@/components/firstrun/ManualInstructions";
import { PairByCode } from "@/components/firstrun/PairByCode";
import { LanguageControl } from "@/components/settings/LanguageControl";
import { AnywhLogo } from "@/components/shell/AnywhLogo";
import { ProfileSetupDialog } from "@/components/shell/ProfileSetupDialog";
import { MAC_TRAFFIC_LIGHTS_INSET, WindowControls } from "@/components/shell/WindowControls";
import { Button } from "@/components/ui/button";
import { useProfileSetup } from "@/hooks/useProfileSetup";
import { useProfiles } from "@/hooks/useProfiles";
import { useDict } from "@/i18n";
import { beginFirstRun, finishFirstRun, type FirstRunScreen } from "@/lib/firstRun";
import { attachPreviousRun, beginLocalInstall, type LocalNote } from "@/lib/localInstall";
import { localInstallPossible, probeLocalRelay, type LocalRelayProbe } from "@/lib/localRelay";
import { isMacOS } from "@/lib/platform";
import { clearProfileRevoked, isProfileRevoked } from "@/lib/profileRevocation";
import { addProfile, removeProfile } from "@/lib/profiles";
import { completeProfileSetup, dismissProfileSetup, resumeProfileSetup, retryProfileSetup } from "@/lib/profileSetup";
import { cn } from "@/lib/utils";

/**
 * What the window shows instead of the shell while this device has no
 * profile. Owns the window frame (the shell's `TitleBar` isn't mounted, and
 * without OS decorations something has to be draggable and closeable), the
 * choice of paths, and the outcome of whichever path was taken — the same
 * `ProfileSetupDialog` the shell shows for a pairing, since both paths here
 * feed the same `profileSetup.ts` queue a deep link or the profile
 * switcher's dialog would.
 *
 * Which screen is showing is plain component state: losing it on a remount
 * costs one click. Whether the first run is *on* is not — see
 * `lib/firstRun.ts` for why the gate can't read the profile list alone.
 */
export function FirstRun() {
  const dict = useDict();
  const copy = dict.firstRun;
  // Where the in-app install exists, the first thing on screen is a look
  // at the machine (`recognition`); everywhere else the paths come straight
  // up, since there is nothing local to find.
  const [screen, setScreen] = useState<FirstRunScreen>(() => (localInstallPossible() ? "detect" : "home"));
  const [probe, setProbe] = useState<LocalRelayProbe | null>(null);
  // The terminal path ends by pointing the connect form at this machine —
  // the relay it just had the reader install is on loopback.
  const [connectHost, setConnectHost] = useState("");
  const setup = useProfileSetup();
  const profiles = useProfiles();

  // Recognition: no network, no install — a read of this machine's disk,
  // and one of three doors. A relay with registered profiles is adopted; a
  // relay with none goes to the wizard past the install; a run from an
  // earlier launch, still alive or interrupted, is picked up where it is.
  useEffect(() => {
    if (!localInstallPossible()) return;
    let cancelled = false;
    probeLocalRelay()
      .then((result) => {
        if (cancelled) return;
        setProbe(result);
        if (!result) {
          setScreen("home");
          return;
        }
        const previous = result.previousRun;
        if (previous && (previous.alive || (!previous.ok && previous.exitCode === null))) {
          void attachPreviousRun(previous);
          setScreen("local");
          return;
        }
        if (result.profiles.some((p) => p.registered)) {
          setScreen("adopt");
          return;
        }
        if (result.installed && result.supported) {
          beginLocalInstall("alreadyInstalled");
          setScreen("local");
          return;
        }
        setScreen("home");
      })
      .catch(() => {
        if (!cancelled) setScreen("home");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const localPath: LocalPathAvailability = !localInstallPossible()
    ? { kind: "hidden" }
    : probe?.containerized
      ? { kind: "unavailable", reason: copy.home.localUnavailable.replace("{container}", probe.containerized) }
      : { kind: "available" };

  // Every render, not once: `beginFirstRun` is idempotent, and re-asserting
  // it is what keeps the gate closed if anything ever flips the flag while
  // this screen is still the one on the window.
  useEffect(() => {
    beginFirstRun();
  });

  // The run after one that died between the claim and the verification:
  // the device's only profile is saved but was never reached, so pick its
  // setup up where it stopped — the dialog opens on "connecting" with no
  // click. A no-op inside `resumeProfileSetup` while a request is already
  // in flight, which is also what makes this safe against the normal flow
  // (the list becomes [unverified] mid-pipeline too) and against StrictMode.
  const soleUnverified = profiles.length === 1 && profiles[0].unverified ? profiles[0] : null;
  useEffect(() => {
    if (soleUnverified) resumeProfileSetup(soleUnverified);
  }, [soleUnverified]);

  function pick(next: FirstRunScreen): void {
    setConnectHost("");
    if (next === "local") beginLocalInstall(localNote());
    setScreen(next);
  }

  /** What the wizard should say under its title when entered from a card
   * or from "create another profile": a relay already here means only the
   * profile is missing. */
  function localNote(): LocalNote {
    return probe?.installed ? "alreadyInstalled" : "none";
  }

  /** "Continue to new profile" — the flow's natural end. */
  function handleContinue(profileId: string): void {
    completeProfileSetup();
    finishFirstRun(profileId);
  }

  /** The duplicate notice's "go to the existing profile" — mirrors the
   * shell's own handler minus the tab it opens: adopt the fresh credentials
   * onto the existing id if that one was revoked, drop the duplicate, land
   * on the existing one. */
  function handleUseExisting(existingId: string): void {
    if (setup.state?.status !== "ready") return;
    const fresh = setup.state.profile;
    if (isProfileRevoked(existingId)) {
      addProfile({ ...fresh, id: existingId });
      clearProfileRevoked(existingId);
    }
    removeProfile(fresh.id);
    dismissProfileSetup();
    finishFirstRun(existingId);
  }

  /** Esc, click-outside, "leave it for later". Only a verified profile hands
   * over to the shell — there is no shell to fall back into for anything
   * short of that, `ready` is the only stage the reconnect loops downstream
   * don't also have to cover from scratch. Every other stage (still running,
   * or failed at connect/verify) just closes the dialog: the profile this
   * request already saved stays on disk as `unverified`, and the
   * `soleUnverified` effect above picks its setup back up next mount — the
   * same path a claim that died mid-setup between app launches already
   * takes. A claim that never landed saved nothing, so this is a no-op for
   * it either way. */
  function handleDismiss(): void {
    if (setup.state?.status === "ready") {
      completeProfileSetup();
      finishFirstRun(setup.state.profile.id);
      return;
    }
    dismissProfileSetup();
  }

  return (
    <div className="flex h-full w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className={cn("flex h-10 shrink-0 select-none border-b border-border bg-bg-chrome", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}>
        {/* `data-tauri-drag-region` applies to this element only, never to
         * children — the caption gets `pointer-events-none` so a drag that
         * starts on the text still moves the window. */}
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center px-2">
          <span className="pointer-events-none font-mono text-[11.5px] text-text-faint">{copy.windowTitle}</span>
        </div>
        <WindowControls />
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-1 justify-center overflow-y-auto">
        <main className="flex w-full max-w-[660px] flex-col gap-7 px-7 pt-12 pb-12">
          <div className="flex items-center gap-3">
            <AnywhLogo className="size-[22px] shrink-0" />
            <span className="flex-1 font-mono text-[10px] font-medium tracking-[0.14em] text-text-faint uppercase">
              {copy.crumbs[screen]}
            </span>
            {screen !== "home" && screen !== "detect" && (
              <Button type="button" variant="outline" size="xs" onClick={() => pick("home")}>
                {copy.back}
              </Button>
            )}
          </div>

          {screen === "detect" && <DetectScreen />}
          {screen === "home" && <FirstRunHome onPick={pick} local={localPath} />}
          {screen === "adopt" && probe && <AdoptScreen probe={probe} onCreateAnother={() => pick("local")} />}
          {screen === "local" && <LocalInstall onTerminal={() => setScreen("manual")} onBack={() => pick("home")} />}
          {screen === "connect" && <ConnectExistingMachine key={connectHost} initialHost={connectHost} />}
          {screen === "code" && <PairByCode />}
          {screen === "manual" && (
            <ManualInstructions
              onDone={() => {
                setConnectHost("127.0.0.1");
                setScreen("connect");
              }}
              onBack={() => pick("home")}
            />
          )}
        </main>
      </div>

      <footer className="flex h-[34px] shrink-0 items-center gap-3 border-t border-border bg-bg-chrome pr-1.5 pl-3.5 font-mono text-[10.5px] text-text-faint">
        <span>{copy.footer.nothingInstalled}</span>
        <div className="flex-1" />
        <LanguageControl className="w-auto border-transparent text-[10.5px] text-text-faint hover:border-border" />
      </footer>

      <CloseDuringInstallDialog />
      <ProfileSetupDialog
        state={setup.state}
        queuedCount={setup.queuedCount}
        onContinue={handleContinue}
        onUseExisting={handleUseExisting}
        onRetry={retryProfileSetup}
        onDismiss={handleDismiss}
      />
    </div>
  );
}
