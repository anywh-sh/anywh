/** A bare filename (no `/` at all) still counts as path-like when it ends
 * in a plausible extension — `App.tsx`, `README.md`. The extension must
 * start with a letter (`[A-Za-z]`) to keep a version string (`v1.2`) or a
 * decimal (`3.14`) from matching: real extensions don't start with a digit. */
const BARE_FILENAME_RE = /^[^/\s]+\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/**
 * Detects whether an inline code span's text (the content of a single
 * backtick span, e.g. `` `screenshots/PROJ-929/foo.png` `` or `` `App.tsx` ``)
 * looks like a file path worth making clickable in the work dir file panel.
 * Deliberately permissive — resolution (`filesClient.resolveChatPath`) runs
 * server-side, on click, and already tolerates a bare filename or a wrong
 * last segment (search + ancestor walk, relay/src/fsFiles.ts); a false
 * positive here just fails closed there rather than costing anything at
 * render time.
 *
 * Excludes: URLs (already handled by `MarkdownContent`'s `a` override), and
 * anything that isn't a single token (whitespace/newline) — the backtick
 * delimiter already gives a clean boundary, no need for a fragile regex over
 * free-form prose.
 */
export function looksLikeFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed !== text) return false;
  if (trimmed.includes("\n") || trimmed.includes(" ")) return false;
  if (looksLikeExternalUrl(trimmed)) return false;
  if (trimmed.includes("/")) return trimmed !== "/";
  return BARE_FILENAME_RE.test(trimmed);
}

/**
 * Whether an `href` is a URL the opener plugin's allowlist actually knows
 * how to open (`http(s)://`, `mailto:`, `tel:`, or the editor deep-link
 * schemes in `capabilities/default.json`) — as opposed to a relative or
 * absolute file path written as a real markdown link (`` [foo](bar/baz.ts) ``
 * instead of backtick code). `MarkdownContent`'s `a` override calls this to
 * decide between the external-open path (`handleExternalLinkClick`) and the
 * file panel path (`onOpenPath`, same as `looksLikeFilePath` above): a path
 * routed to `openUrl` fails the plugin's scope check and silently no-ops —
 * `preventDefault` already stopped the webview's own in-place navigation, so
 * there's no fallback and the click just does nothing.
 *
 * Requires `://` rather than a bare `scheme:` so a Windows absolute path
 * (`C:\Users\...`) isn't mistaken for a URL with scheme `c` — same guard
 * `looksLikeFilePath` already relies on above.
 */
export function looksLikeExternalUrl(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(href) || href.startsWith("mailto:") || href.startsWith("tel:");
}
