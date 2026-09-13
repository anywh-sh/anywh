import { useEffect, useState } from "react";
import { ConnectExistingMachine } from "@/components/firstrun/ConnectExistingMachine";
import { FirstRunHome } from "@/components/firstrun/FirstRunHome";
import { ManualInstructions } from "@/components/firstrun/ManualInstructions";
import { PairByCode } from "@/components/firstrun/PairByCode";
import { AnywhLogo } from "@/components/shell/AnywhLogo";
import { LanguageControl } from "@/components/shell/LanguageControl";
import { ProfileSetupDialog } from "@/components/shell/ProfileSetupDialog";
import { MAC_TRAFFIC_LIGHTS_INSET, WindowControls } from "@/components/shell/WindowControls";
import { Button } from "@/components/ui/button";
import { useProfileSetup } from "@/hooks/useProfileSetup";
import { useDict } from "@/i18n";
import { beginFirstRun, finishFirstRun, type FirstRunScreen } from "@/lib/firstRun";
import { isMacOS } from "@/lib/platform";
import { clearProfileRevoked, isProfileRevoked } from "@/lib/profileRevocation";
import { addProfile, removeProfile, type Profile } from "@/lib/profiles";
import {
  completeProfileSetup,
  dismissProfileSetup,
  retryProfileSetup,
  type SetupState,
} from "@/lib/profileSetup";
import { cn } from "@/lib/utils";

/** The profile a setup request has already written to the list, if any —
 * everything past the claim has one, and a claim that never landed has
 * nothing to hand over. */
function savedProfileOf(state: SetupState | null): Profile | null {
  if (state === null) return null;
  switch (state.status) {
    case "claiming":
      return null;
    case "failed":
      return state.stage === "claim" ? null : state.profile;
    default:
      return state.profile;
  }
}

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
  const [screen, setScreen] = useState<FirstRunScreen>("home");
  // The terminal path ends by pointing path 01 at this machine — the relay
  // it just had the reader install is on loopback.
  const [connectHost, setConnectHost] = useState("");
  const setup = useProfileSetup();

  // Every render, not once: `beginFirstRun` is idempotent, and re-asserting
  // it is what keeps the gate closed if anything ever flips the flag while
  // this screen is still the one on the window.
  useEffect(() => {
    beginFirstRun();
  });

  function pick(next: FirstRunScreen): void {
    setConnectHost("");
    setScreen(next);
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

  /** Esc, click-outside, "leave it for later". There is no "later" before
   * the shell exists: once a profile has been saved, dismissing means the
   * same as continuing — the shell is the only place left to go, and it
   * takes the profile as it is (verified or not; the shell's own reconnect
   * loops report the latter). Only a claim that never landed leaves the
   * reader here, with the paths, and nothing saved. */
  function handleDismiss(): void {
    const saved = savedProfileOf(setup.state);
    if (saved) {
      completeProfileSetup();
      finishFirstRun(saved.id);
      return;
    }
    dismissProfileSetup();
  }

  return (
    <div className="flex h-full w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className={cn("flex h-10 shrink-0 select-none border-b border-border bg-bg-chrome", isMacOS() && MAC_TRAFFIC_LIGHTS_INSET)}>
        {/* Mirrors `WindowControls`' width on the other side so the title
         * centers on the bar itself, not on whatever's left after it. */}
        <div className="invisible" aria-hidden="true">
          <WindowControls />
        </div>
        {/* `data-tauri-drag-region` applies to this element only, never to
         * children — the caption gets `pointer-events-none` so a drag that
         * starts on the text still moves the window. */}
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center px-2">
          <span className="pointer-events-none font-mono text-[11.5px] text-text-faint">{copy.windowTitle}</span>
        </div>
        <WindowControls />
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-1 justify-center overflow-y-auto">
        {/* `my-auto` rather than `items-center` on the scroll container:
         * auto margins collapse to zero instead of clipping the top of the
         * content once it's taller than the window, which is what centering
         * via `align-items` would do here. */}
        <main className="my-auto flex w-full max-w-[660px] flex-col gap-7 px-7 py-12">
          <div className="flex items-center gap-3">
            <AnywhLogo className="size-[22px] shrink-0" />
            <span className="flex-1 font-mono text-[10px] font-medium tracking-[0.14em] text-text-faint uppercase">
              {copy.crumbs[screen]}
            </span>
            {screen !== "home" && (
              <Button type="button" variant="outline" size="xs" onClick={() => pick("home")}>
                {copy.back}
              </Button>
            )}
          </div>

          {screen === "home" && <FirstRunHome onPick={pick} />}
          {screen === "connect" && <ConnectExistingMachine key={connectHost} initialHost={connectHost} />}
          {screen === "code" && <PairByCode />}
          {screen === "manual" && (
            <ManualInstructions
              onDone={() => {
                setConnectHost("127.0.0.1");
                setScreen("connect");
              }}
            />
          )}
        </main>
      </div>

      <footer className="flex h-[34px] shrink-0 items-center gap-3 border-t border-border bg-bg-chrome pr-1.5 pl-3.5 font-mono text-[10.5px] text-text-faint">
        <span>{copy.footer.nothingInstalled}</span>
        <div className="flex-1" />
        <LanguageControl />
      </footer>

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
