// Pure URL formatting for "open in editor" — deep links only,
// never a CLI invocation: `@tauri-apps/plugin-opener`'s `openUrl` passes
// exactly one argument (`open::with_detached` -> `Command::new(app).arg(url)`,
// always via `/usr/bin/open -a <App>` on macOS), so anything needing two
// arguments (e.g. the officially documented `code --folder-uri <uri>`) is
// simply not reachable this way, and a bare editor binary name would break
// on macOS anyway (the Finder-launched app inherits a PATH without
// `/usr/local/bin`). Zed's two forms are confirmed straight from its source
// (`crates/zed/src/zed/open_listener.rs`); the VS Code family's local form
// is the long-documented "Open in VS Code" URI handler, but its SSH-remote
// form is community convention, not official docs.

/** Doubles as the URL scheme (`{id}://...`) — the human-readable label for
 * each editor comes from the Rust `detect_editors` command instead of a
 * second map here, so there's only one place that spells "VS Code". */
export type EditorId = "zed" | "vscode" | "cursor" | "windsurf";

/** Mirrors the relay's `EditorDescriptor` (editorHostInfo.ts) — kept as a
 * separate type rather than a shared import since relay and client are
 * different TypeScript projects with no shared package. */
export type EditorLocality = null | { kind: "local" } | { kind: "ssh"; user: string; host: string; port?: number };

export interface EditorLinkTarget {
  /** Absolute path as the relay reports it — POSIX or Windows, never a
   * client-local path (the file lives on the relay's machine). */
  path: string;
  line?: number;
  column?: number;
}

/**
 * Percent-encodes one path segment, then un-escapes `:` back to a literal
 * colon — the one character `encodeURIComponent` mangles that a path
 * legitimately needs raw, namely a Windows drive letter's colon. Everything
 * else that matters (space, `#`, accented characters) stays encoded.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/g, ":");
}

/**
 * Normalizes a relay-reported path into the absolute, forward-slash,
 * percent-encoded form every deep link scheme expects — `/` is preserved as
 * a separator (never encoded), and a Windows drive path gets a leading `/`
 * added (`C:\Users\x` -> `/C:/Users/x`), matching how VS Code/Zed's `file`
 * URI parsers expect a drive path to be presented.
 */
function encodePathForEditorUrl(rawPath: string): string {
  const posix = rawPath.replace(/\\/g, "/");
  const normalized = /^[A-Za-z]:\//.test(posix) ? `/${posix}` : posix;
  return normalized
    .split("/")
    .map((segment) => (segment === "" ? "" : encodeSegment(segment)))
    .join("/");
}

function lineColumnSuffix(line: number | undefined, column: number | undefined): string {
  if (line === undefined) return "";
  return column === undefined ? `:${String(line)}` : `:${String(line)}:${String(column)}`;
}

/**
 * `user@host` or `user@host:port` — kept separate from `encodePathForEditorUrl`
 * on purpose: the `@` and the port's `:` are structural to the URL's
 * authority component, not path content, so they must never go through the
 * path's percent-encoding. `user`/`host` come from `ANYWH_EDITOR_SSH`,
 * already validated relay-side (`editorHostInfo.ts`'s `parseEditorSsh`).
 */
function sshAuthority(user: string, host: string, port: number | undefined): string {
  return port === undefined ? `${user}@${host}` : `${user}@${host}:${String(port)}`;
}

/**
 * Builds the deep link URL to open `target` in `editor`, or `null` when
 * `locality` is `null` (both `ANYWH_EDITOR_LOCAL`/`ANYWH_EDITOR_SSH`
 * unset relay-side — the caller should have already hidden the feature in
 * that case; this is just the defensive mirror of that contract).
 *
 * The SSH-remote form for the VS Code family (`vscode-remote/ssh-remote+`)
 * is unverified beyond community convention.
 */
export function buildEditorUrl(editor: EditorId, locality: EditorLocality, target: EditorLinkTarget): string | null {
  if (!locality) return null;

  const encodedPath = encodePathForEditorUrl(target.path);
  const suffix = lineColumnSuffix(target.line, target.column);

  if (locality.kind === "local") {
    return `${editor}://file${encodedPath}${suffix}`;
  }

  const authority = sshAuthority(locality.user, locality.host, locality.port);
  if (editor === "zed") {
    return `zed://ssh/${authority}${encodedPath}${suffix}`;
  }
  return `${editor}://vscode-remote/ssh-remote+${authority}${encodedPath}${suffix}`;
}
