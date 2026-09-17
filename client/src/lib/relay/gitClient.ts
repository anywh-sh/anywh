import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

// Client for the status bar's left half (`GET /git/status`, see
// relay/src/gitStatus.ts). Session-scoped like the file panel's protocol:
// the relay resolves which folder to look at from the session id, so nothing
// here ever sends a path.

export type GitStatus = { repo: false } | { repo: true; branch: string; detached: boolean; changes: number };

/** Rejects like any other relay call — the caller decides that a machine
 * that can't be reached simply has no repository to talk about. */
export async function getGitStatus(profile: Profile, sessionId: string): Promise<GitStatus> {
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${port}/git/status?session=${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return (await response.json()) as GitStatus;
}
