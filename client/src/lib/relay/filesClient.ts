import type { EditorLocality } from "@/lib/platform/editorLinks";
import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

// Client for the work dir file panel's protocol — mirrors
// `fsBrowse.ts`'s pattern (thin fetch wrappers over the relay's HTTP API),
// but rooted at a session's cwd instead of an arbitrary path (see
// relay/src/fsFiles.ts).

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  mtimeMs: number;
}

export interface FilesListResult {
  root: string;
  path: string;
  entries: FileEntry[];
}

export type FileReadResult =
  | { kind: "text"; path: string; content: string; size: number; mtimeMs: number; truncated: boolean }
  | { kind: "image"; path: string; size: number; mtimeMs: number; mime: string }
  | { kind: "binary"; path: string; size: number; mtimeMs: number };

/** Resolves the relay's actual base URL for `profile` — the sidecar's local
 * address for a tailnet profile, `host`/`relayPort` straight for a direct
 * one (`resolveConnection`) — plus the connect token, if any,
 * that has to ride along on every one of these requests. */
async function resolveBase(profile: Profile): Promise<{ base: string; token?: string }> {
  const { host, port, token } = await resolveConnection(profile);
  return { base: `http://${host}:${port}`, token };
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, payload: unknown, token?: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${String(response.status)}`);
  }
  return response.json() as Promise<T>;
}

/** `path` omitted lists the session's root. Lazy by design — the caller
 * (`FileTree`) only ever asks for one folder at a time, never recursively. */
export async function listFiles(profile: Profile, sessionId: string, path?: string, showHidden?: boolean): Promise<FilesListResult> {
  const params = new URLSearchParams({ session: sessionId });
  if (path) params.set("path", path);
  if (showHidden) params.set("all", "1");
  const { base, token } = await resolveBase(profile);
  return getJson<FilesListResult>(`${base}/files/list?${params.toString()}`, token);
}

export async function readFile(profile: Profile, sessionId: string, path: string): Promise<FileReadResult> {
  const params = new URLSearchParams({ session: sessionId, path });
  const { base, token } = await resolveBase(profile);
  return getJson<FileReadResult>(`${base}/files/read?${params.toString()}`, token);
}

export interface ChatPathResolution {
  target: string | null;
  isDirectory: boolean;
  existingDirs: string[];
}

/** Resolves a path mentioned in chat text (`MarkdownContent`'s `code`
 * override) — server-side, since a bare filename needs a search under the
 * session's root and a wrong last segment needs an ancestor walk, neither
 * of which the client can do cheaply (see relay/src/fsFiles.ts). */
export async function resolveChatPath(profile: Profile, sessionId: string, path: string): Promise<ChatPathResolution> {
  const params = new URLSearchParams({ session: sessionId, path });
  const { base, token } = await resolveBase(profile);
  return getJson<ChatPathResolution>(`${base}/files/resolve?${params.toString()}`, token);
}

function rawFilePath(sessionId: string, path: string, mtimeMs: number): string {
  // `?v=<mtimeMs>` busts the webview's cache so a changed image (agent
  // overwrote it, or the watch noticed a change) actually
  // reloads instead of showing stale bytes.
  const params = new URLSearchParams({ session: sessionId, path, v: String(mtimeMs) });
  return `/files/raw?${params.toString()}`;
}

/** Direct URL for a plain `<img src>` — only valid for a direct-mode
 * profile, whose `host`/`relayPort` are real, dialable values. A tailnet
 * profile's are the sidecar placeholder (`isTailnetProfile`), and every
 * connection through the tunnel needs its own fresh, single-use connect
 * token — something a plain image tag has no way to attach,
 * and that a *second* image load (e.g. after the watch reports a change)
 * would just get rejected as a replay if it somehow could. See
 * `fetchRawFile` below for that case. */
export function rawFileUrl(profile: Profile, sessionId: string, path: string, mtimeMs: number): string {
  return `http://${profile.host}:${profile.relayPort}${rawFilePath(sessionId, path, mtimeMs)}`;
}

/** Tailnet-mode counterpart of `rawFileUrl` — fetches the bytes with a
 * proper `Authorization` header and hands back a `Blob`, unchanged from the
 * relay (no re-encoding, so no quality loss); the caller turns it into an
 * object URL (`URL.createObjectURL`) for an `<img src>`. Works for a direct
 * profile too (the header is simply absent), so a caller doesn't need to
 * branch on profile mode itself if it doesn't already for other reasons —
 * `FileViewer` still does, to keep paying zero extra cost (no JS-mediated
 * fetch, native browser caching/progressive decode) for the common
 * self-host case, which is the majority of anywh's users. */
export async function fetchRawFile(profile: Profile, sessionId: string, path: string, mtimeMs: number): Promise<Blob> {
  const { base, token } = await resolveBase(profile);
  const response = await fetch(`${base}${rawFilePath(sessionId, path, mtimeMs)}`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.blob();
}

/** `dir` omitted creates at the session's root — today the only caller
 * (`FileTree`'s panel-level "new file" context menu) never creates inside a
 * specific folder. */
export async function createFile(profile: Profile, sessionId: string, name: string, dir?: string): Promise<{ path: string }> {
  const { base, token } = await resolveBase(profile);
  return postJson(`${base}/files/create`, { session: sessionId, dir: dir ?? null, name }, token);
}

/** `dir` omitted uploads at the session's root — mirrors `createFile`'s
 * confinement/fail-closed behavior (relay/src/fsFiles.ts), just with the
 * dropped file's bytes as content instead of an empty file. `content` is
 * sent as the raw request body (not multipart/JSON), same style as
 * `imageUpload.ts`'s `uploadAttachment`. */
export async function uploadFile(profile: Profile, sessionId: string, name: string, content: ArrayBuffer, dir?: string): Promise<{ path: string }> {
  const params = new URLSearchParams({ session: sessionId, name });
  if (dir) params.set("dir", dir);
  const { base, token } = await resolveBase(profile);
  const response = await fetch(`${base}/files/upload?${params.toString()}`, {
    method: "POST",
    headers: authHeaders(token),
    body: content,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${String(response.status)}`);
  }
  return response.json() as Promise<{ path: string }>;
}

/** File-only write surface — the context menu that drives these (`FileTree`)
 * never shows delete/rename for a directory row. */
export async function deleteFile(profile: Profile, sessionId: string, path: string): Promise<void> {
  const { base, token } = await resolveBase(profile);
  await postJson(`${base}/files/delete`, { session: sessionId, path }, token);
}

/** Renames within the same directory — `newName` is a bare filename, never
 * a full path (see `relay/src/fsFiles.ts`). Returns the new absolute path
 * so the caller can move an open tab to follow the file. */
export async function renameFile(profile: Profile, sessionId: string, path: string, newName: string): Promise<{ path: string }> {
  const { base, token } = await resolveBase(profile);
  return postJson(`${base}/files/rename`, { session: sessionId, path, newName }, token);
}

/** One entry of `/host-info`'s `agents` — every agent id this relay's
 * `SELECTABLE_AGENT_IDS` (server.ts) names AND has its binary actually
 * installed (a relay without `codex` on `$PATH` only ever reports
 * `"claude"`, even though both are selectable in principle). Capability
 * values are relay's `CapabilityLevel` strings ("native"/"bridged"/"none"),
 * kept as `Record<string, string>` rather than mirroring the full
 * `AgentCapability` union client-side — no consumer here reads a specific
 * key yet. */
export interface SelectableAgentInfo {
  id: string;
  capabilities: Record<string, string>;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  editor: EditorLocality;
  /** Optional: an older relay simply omits it, same shape as `version`
   * (server.ts) — empty/absent until the boot-time detection probe
   * resolves. */
  agents?: SelectableAgentInfo[];
}

/** Whether/how the client can open a file panel path in a local editor —
 * `editor: null` means both `ANYWH_EDITOR_LOCAL` and
 * `ANYWH_EDITOR_SSH` are unset relay-side, and the feature should be
 * hidden entirely (see `relay/src/editorHostInfo.ts`). */
export async function getHostInfo(profile: Profile): Promise<HostInfo> {
  const { base, token } = await resolveBase(profile);
  return getJson<HostInfo>(`${base}/host-info`, token);
}
