import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { deleteSession } from "@/lib/relay/relayClient";

/** Drops the empty session a new-session tab had opened on the relay. Best
 * effort: it is not listed anywhere, and a failure leaves nothing visible. */
export async function discardBlankSession(profile: Profile, sessionId: string): Promise<void> {
  try {
    const { host, port, token } = await resolveConnection(profile);
    await deleteSession(host, port, sessionId, token);
  } catch {
    // Nothing to tell the person: the session never had a title.
  }
}
