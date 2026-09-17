import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "@/lib/platform/tauri";
import { isIOS } from "@/lib/platform/platform";

/**
 * OS window focus — distinct from "active tab within the app". Used to
 * decide whether a conversation is actually visible to the user (switching tabs
 * within the app + alt-tabbing to another app are the two ways of "not looking").
 * Outside Tauri, always assumes focused (no API to check, and it's not the
 * context where the turn-complete notification fires anyway).
 *
 * On iOS uses `document.visibilityState`/`visibilitychange` instead of Tauri's
 * window focus API — real finding (Simulator spike): "window"
 * focus there maps to UIKit's `applicationWillResignActive`/
 * `DidBecomeActive` pair, which fires for any momentary
 * interruption (Control Center, a system alert, the native notification
 * permission prompt itself) — not just when the app actually goes to the
 * background for real. Practical result: turn-complete notification firing
 * even with the user looking straight at the screen, because `windowFocused`
 * blipped to `false` for an instant unrelated to real backgrounding. Meanwhile
 * `document.hidden` is the standard web API precisely for "the page is
 * genuinely out of view", and only becomes `true` on the real background
 * transition in WKWebView (confirmed in the same spike: fires shortly before
 * the process gets suspended, not on focus blips). Desktop keeps Tauri's
 * window API (there, "losing focus" IS the correct signal — alt-tabbing to another
 * app should indeed count as "not looking", unlike iOS). */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (isIOS()) {
      setFocused(!document.hidden);
      const onVisibilityChange = () => setFocused(!document.hidden);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }

    if (!inTauri()) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.isFocused().then(setFocused);
    void appWindow.onFocusChanged(({ payload }) => setFocused(payload)).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, []);

  return focused;
}
