import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListResult {
  path: string;
  entries: FsEntry[];
}

/** Lists subfolders of `path` on the relay (the machine where the agent
 * runs, not the client device) — see relay/src/fs/fsBrowse.ts for the full
 * contract. Without `path`, the relay resolves to the app's (profile's)
 * default. `showHidden` mirrors the file panel's own toggle (`all=1`) — off
 * by default, dotdirs and `node_modules` are filtered out of the listing. */
export async function listDirectories(profile: Profile, path?: string, showHidden?: boolean): Promise<FsListResult> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (showHidden) params.set("all", "1");
  const qs = params.toString() ? `?${params.toString()}` : "";
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${port}/fs/list${qs}`, { headers: authHeaders(token) });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}
