import { openUrl } from "@tauri-apps/plugin-opener";
import { isMacOS } from "@/lib/platform/platform";

type LinkClickEvent = Pick<MouseEvent, "ctrlKey" | "metaKey">;

/**
 * Whether a click that landed on a terminal link should actually open it.
 *
 * A bare click deliberately does nothing: inside a terminal the pointer is
 * first and foremost a text-selection tool, and a click that happens to start
 * on a URL would otherwise throw a browser window at the user. The modifier
 * follows each OS's own convention — Cmd on macOS, Ctrl on Windows/Linux —
 * the same split every terminal emulator and editor uses.
 */
export function shouldActivateTerminalLink(event: LinkClickEvent, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * Activation handler shared by the two ways a link can reach the terminal:
 * the web-links addon (URLs matched in plain output) and `linkHandler` (OSC 8
 * hyperlinks, which modern CLIs emit). Both end at the opener plugin — the
 * same path chat links take through `handleExternalLinkClick` — so the URL
 * opens in the system browser instead of inside the app's webview.
 */
export function openTerminalLink(event: LinkClickEvent, uri: string): void {
  if (!shouldActivateTerminalLink(event, isMacOS())) return;
  void openUrl(uri);
}
