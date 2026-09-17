import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { onAction } from "@tauri-apps/plugin-notification";
import { inTauri } from "@/lib/platform/tauri";

export interface NotificationClickPayload {
  sessionId: string;
  profileId: string;
}

/**
 * Routes a click on a turn-completed notification (`lib/notifications.ts`)
 * back to the right tab/profile — two parallel channels, because capturing
 * the click itself is implemented differently per platform:
 *
 * - Windows: `src-tauri/src/notifications.rs` implements the toast by hand
 *   (`windows_toast`, the plugin doesn't forward the click to JS on this OS
 *   — reason already documented there) and emits the Tauri event
 *   `notification-clicked` on `on_activated`.
 * - iOS: `tauri-plugin-notification` already has a native handler
 *   (`NotificationHandler.swift`) that forwards the tap to JS's `onAction`,
 *   reading the `extra` payload Rust attaches to the notification
 *   (non-Windows branch of `notify_turn_complete`).
 * - macOS/Linux: this plugin's crate (`tauri-plugin-notification` 2.3.3)
 *   uses `notify-rust` on desktop and **has no click hook implemented at
 *   all** — neither emits a Tauri event nor triggers `onAction`. Clicking
 *   the notification there just brings the app to focus (default OS
 *   behavior, outside our control), without switching tabs. Replicating
 *   real routing on these platforms would require our own native module,
 *   in the same spirit as what already exists for Windows — not part of
 *   this round.
 *
 * Known limitation on any platform: the listener only exists after React
 * mounts. If the app is fully closed (not just minimized/backgrounded)
 * when the notification is clicked, the click reopens the app but the
 * payload arrives too early to be heard — routing is lost and it falls
 * back to default behavior (app opens on the last tab, no switching).
 * Covers the common case (app running, unfocused); we don't implement a
 * queue/replay for cold reopening.
 */
export function useNotificationClick(onClick: (payload: NotificationClickPayload) => void): void {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEffect(() => {
    if (!inTauri()) return;

    const unlistenPromise = listen<NotificationClickPayload>("notification-clicked", (event) => {
      onClickRef.current(event.payload);
    });
    const actionListenerPromise = onAction((notification) => {
      const sessionId = notification.extra?.sessionId;
      const profileId = notification.extra?.profileId;
      if (typeof sessionId === "string" && typeof profileId === "string") {
        onClickRef.current({ sessionId, profileId });
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      void actionListenerPromise.then((listener) => listener.unregister());
    };
  }, []);
}
