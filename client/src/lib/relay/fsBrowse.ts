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
 * runs, not the client device) — see relay/src/fsBrowse.ts for the full
 * contract. Without `path`, the relay resolves to the app's (profile's)
 * default. */
export async function listDirectories(profile: Profile, path?: string): Promise<FsListResult> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${port}/fs/list${qs}`, { headers: authHeaders(token) });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}
