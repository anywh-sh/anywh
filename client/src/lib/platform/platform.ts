import { platform } from "@tauri-apps/plugin-os";
import { inTauri } from "@/lib/platform/tauri";

export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
}

/** iOS via `@tauri-apps/plugin-os` (official API, `window.__TAURI_OS_PLUGIN_INTERNALS__`)
 * instead of UA sniffing — WKWebView on iOS can report an ambiguous UA, so
 * `isMacOS()` isn't extended to cover this case. */
export function isIOS(): boolean {
  return inTauri() && platform() === "ios";
}

/** The platform's command modifier as its keycap reads: "⌘" on macOS,
 * "Ctrl" on Windows/Linux. */
export function modifierKeyLabel(): string {
  return isMacOS() ? "⌘" : "Ctrl";
}

/** Shift as the platform writes it: "⇧" on macOS, "Shift" on Windows/Linux. */
export function shiftKeyLabel(): string {
  return isMacOS() ? "⇧" : "Shift";
}

/** Shortcut label for the tooltip — "⌘K" on macOS, "Ctrl+K" on Windows/Linux. */
export function shortcutLabel(key: string): string {
  return isMacOS() ? `⌘${key}` : `Ctrl+${key}`;
}

/** The same shortcut as separate keys — ["⌘", "K"] or ["Ctrl", "K"] — for
 * UI that draws each key as its own cap. */
export function shortcutKeys(key: string): string[] {
  return [modifierKeyLabel(), key];
}

/** This device's OS, straight from `@tauri-apps/plugin-os` ("macos",
 * "windows", "linux", "ios", "android", ...) — `null` outside Tauri, where
 * there's no OS to report. Purely descriptive: nothing here knows or cares
 * who ends up reading it. */
export function currentPlatform(): string | null {
  return inTauri() ? platform() : null;
}
