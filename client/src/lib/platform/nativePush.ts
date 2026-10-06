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
