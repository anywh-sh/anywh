import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Handler for clicks on links inside the app: by default Tauri navigates the
 * webview itself to the href (replacing the whole app), instead of opening in the
 * system browser — always intercepts and delegates to the opener plugin.
 *
 * Typed as a plain `Element` event (not `HTMLAnchorElement`) since
 * `MarkdownContent` reuses this for a backtick-wrapped URL rendered as an
 * `<a>` through the `code` override too, not just the `a` override's real
 * anchors — the function never touches anchor-specific fields, only
 * `preventDefault`.
 */
export function handleExternalLinkClick(event: MouseEvent<Element>, href: string): void {
  event.preventDefault();
  void openUrl(href);
}
