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

/** Shortcut label for the tooltip — "⌘K" on macOS, "Ctrl+K" on Windows/Linux. */
export function shortcutLabel(key: string): string {
  return isMacOS() ? `⌘${key}` : `Ctrl+${key}`;
}

/** This device's OS, straight from `@tauri-apps/plugin-os` ("macos",
 * "windows", "linux", "ios", "android", ...) — `null` outside Tauri, where
 * there's no OS to report. Purely descriptive: nothing here knows or cares
 * who ends up reading it. */
export function currentPlatform(): string | null {
  return inTauri() ? platform() : null;
}
