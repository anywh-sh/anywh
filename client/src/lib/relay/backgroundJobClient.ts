import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

// Client for `GET /background-jobs/log` (relay/src/routes/host.ts) — what a
// running `anywh-bg` job has printed so far. Session-scoped like
// `gitClient.ts`: the client names the job, the relay finds its log file.

/** Rejects on anything but a 200 — a job that just finished (404), a relay
 * too old for the route, an unreachable machine. The caller keeps whatever it
 * last showed instead of treating any of those as an error worth surfacing. */
export async function getBackgroundJobLog(profile: Profile, sessionId: string, jobId: string): Promise<string> {
  const { host, port, token } = await resolveConnection(profile);
  const query = `session=${encodeURIComponent(sessionId)}&job=${encodeURIComponent(jobId)}`;
  const response = await fetch(`http://${host}:${port}/background-jobs/log?${query}`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return ((await response.json()) as { tail: string }).tail;
}
