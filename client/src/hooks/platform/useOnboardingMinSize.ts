import { useEffect } from "react";
import { currentPlatform } from "@/lib/platform/platform";
import { inTauri } from "@/lib/platform/tauri";

/** The smallest window the onboarding's 560px column and its card still
 * read well in. Applied only while the onboarding is on screen. */
export const ONBOARDING_MIN_SIZE = { width: 480, height: 520 } as const;

/** The one window call this needs, in logical pixels; `null` lifts the
 * minimum. Injected, so the hook can be driven without Tauri. */
export interface MinSizeWindow {
  setMinSize(size: { width: number; height: number } | null): Promise<void>;
}

/** Only on a desktop window: the permission lives in `desktop.json` alone,
 * so on iOS (and in a browser) there is nothing to call, and no IPC goes
 * out without it. */
export function enforcesMinSize(tauri: boolean, platform: string | null): boolean {
  return tauri && (platform === "linux" || platform === "macos" || platform === "windows");
}

async function currentWindow(): Promise<MinSizeWindow> {
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  return {
    setMinSize: (size) => appWindow.setMinSize(size ? new LogicalSize(size.width, size.height) : null),
  };
}

function warn(err: unknown): void {
  console.warn("[anywh] onboarding: couldn't set the window's minimum size", err);
}

/**
 * Holds the window at `ONBOARDING_MIN_SIZE` or larger for as long as the
 * calling component is mounted, and lifts it on unmount — the app's own
 * config sets no minimum, so `null` really restores what was there. A
 * failure is logged and otherwise ignored: a window that can shrink more
 * than it should is not worth an error on screen.
 */
export function useOnboardingMinSize(
  getWindow: () => Promise<MinSizeWindow> = currentWindow,
  enabled: boolean = enforcesMinSize(inTauri(), currentPlatform()),
): void {
  useEffect(() => {
    if (!enabled) return;
    const target = getWindow();
    target.then((w) => w.setMinSize({ ...ONBOARDING_MIN_SIZE })).catch(warn);
    return () => {
      target.then((w) => w.setMinSize(null)).catch(warn);
    };
  }, [getWindow, enabled]);
}
