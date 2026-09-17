import { useEffect } from "react";
import { inTauri } from "@/lib/platform/tauri";

/**
 * Suppresses the WebView's own right-click menu (Reload/Back/Inspect
 * Element) app-wide — left alone, it makes a packaged desktop app feel like
 * a browser tab. Scoped to `inTauri()` so `npm run dev` opened in a regular
 * browser (Playwright inspection, same reasoning as `lib/tauri.ts`) keeps
 * its own right-click menu for DevTools.
 *
 * Exempts anything where the native menu is still the only way to
 * copy/paste: `input`/`textarea`/`[contenteditable]` and `.selectable-content`
 * (message bubbles, code/markdown viewers, the terminal — see `index.css`'s
 * `user-select` rules, which draw the same line). Every other right-click
 * handler in the app (`useContextMenu.tsx`'s custom menus in `FileTree`,
 * `SessionListItem`, `TabGroupStrip`) already calls `stopPropagation` on its
 * own `contextmenu` event, so this listener — attached on `document`, above
 * all of them — never actually reaches those cases.
 */
export function useContextMenuGuard(): void {
  useEffect(() => {
    if (!inTauri()) return;

    function handleContextMenu(event: MouseEvent): void {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .selectable-content")) return;
      event.preventDefault();
    }

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);
}
