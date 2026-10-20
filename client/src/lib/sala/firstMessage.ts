import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { deleteSession } from "@/lib/relay/relayClient";
import { sendFirstRoomMessage } from "@/lib/relay/roomClient";

const ATTEMPTS = 3;
const RETRY_MS = 1_000;

/** Hands a new room's first message to its principal, trying a few times
 * (the room was only just created; its session may not be reachable on the
 * first try). `onFailure` runs when every attempt failed. */
export async function deliverFirstRoomMessage(profile: Profile, roomId: string, text: string, onFailure: () => void): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      if (await sendFirstRoomMessage(profile, roomId, text)) return;
    } catch (error) {
      console.error("[anywh] could not deliver a room's first message", error);
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  onFailure();
}

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
