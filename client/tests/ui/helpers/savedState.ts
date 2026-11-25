/** What the app has saved on this device, read the way a restart would: the
 * tab strip and the conversation list's cache (`localStorage`, never the
 * React state a test must not reach into). */

/** The tabs as saved. */
export function savedTabs(): { id: string; room?: boolean; bot?: boolean; agentOf?: string }[] {
  return JSON.parse(localStorage.getItem("anywh:tabs") ?? "[]") as { id: string; room?: boolean; bot?: boolean; agentOf?: string }[];
}

/** Every session id the conversation list holds, whatever the profile. */
export function listedSessionIds(): string[] {
  const cache = JSON.parse(localStorage.getItem("anywh:session-list-cache") ?? "{}") as Record<string, { sessions: { id: string }[] }>;
  return Object.values(cache).flatMap((entry) => entry.sessions.map((session) => session.id));
}
