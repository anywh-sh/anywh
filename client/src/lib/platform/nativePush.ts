import { addPluginListener, invoke } from "@tauri-apps/api/core";

/** `sandbox` tokens only work against APNs' development endpoint, `production`
 * ones against the production endpoint — whoever sends the push needs both
 * values. */
export interface PushRegistration {
  token: string;
  environment: "sandbox" | "production";
}

/**
 * Asks iOS for an APNs device token. Resolves with the first token the system
 * hands back and rejects if registration fails or times out. Implemented by
 * the `tauri-plugin-native-chrome` plugin (`ios/Sources/PushRegistration.swift`);
 * iOS only.
 */
export function registerForPush(): Promise<PushRegistration> {
  return invoke<PushRegistration>("plugin:native-chrome|register_for_push");
}

/** Fires when iOS hands out a token nobody asked for (it may rotate on any
 * launch). */
export async function listenPushToken(handler: (event: PushRegistration) => void): Promise<() => void> {
  const listener = await addPluginListener("native-chrome", "pushToken", handler);
  return () => void listener.unregister();
}

/** Which session a tapped push notification should open. `profileId` is the
 * profile id on this device, echoed from what was registered with the relay. */
export interface PushTap {
  sessionId: string;
  profileId: string | null;
}

/** Tells the native side which session is on screen (`null`: none), so a push
 * about that session is not shown over it while the app is in the foreground.
 * iOS only. */
export function setVisibleSession(sessionId: string | null): Promise<void> {
  return invoke("plugin:native-chrome|set_visible_session", { payload: { sessionId } });
}

/** The tap on a push notification that opened the app before the page was
 * listening, if any. Calling it also tells the native side the page is
 * listening: from then on taps arrive through `listenPushNotificationClicked`
 * instead of being held. Call it once on mount, after registering the
 * listener. */
export async function takePendingPushTap(): Promise<PushTap | null> {
  const { tap } = await invoke<{ tap: { sessionId: string; profileId?: string | null } | null }>("plugin:native-chrome|take_pending_push_tap");
  return tap ? { sessionId: tap.sessionId, profileId: tap.profileId ?? null } : null;
}

/** Fires when a push notification is tapped while the page is listening. */
export async function listenPushNotificationClicked(handler: (tap: PushTap) => void): Promise<() => void> {
  const listener = await addPluginListener<{ sessionId: string; profileId?: string | null }>("native-chrome", "pushNotificationClicked", (event) =>
    handler({ sessionId: event.sessionId, profileId: event.profileId ?? null }),
  );
  return () => void listener.unregister();
}
