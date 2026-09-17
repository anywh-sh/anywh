import { invoke } from "@tauri-apps/api/core";

/** iOS native menu item — `systemIcon` is the name of an SF Symbol
 * (e.g. `"doc.on.doc"`, `"pencil"`), rendered by UIKit itself on the Swift
 * side. `disabledReason` becomes the `UIAction`'s `subtitle` when `disabled`
 * — used by the edit-message-with-image button (v1 doesn't support it). */
export interface NativeMenuItem {
  id: string;
  label: string;
  systemIcon?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * iOS native context menu — `UIEditMenuInteraction` (public API since iOS
 * 16) presented at the touch point, the same rounded icon+label style as
 * the system's text-selection menu. Chosen instead of
 * `UIContextMenuInteraction` because that one only fires via the system's
 * own gesture (automatic long-press); `UIEditMenuInteraction` has
 * `presentEditMenu(with:)`, public and imperative, which accepts an
 * arbitrary point — which allows triggering it from the long-press detected
 * in JS (`useLongPress`) instead of depending on a native gesture recognizer
 * attached to a specific DOM element (impossible, the content is a
 * WebView).
 *
 * Resolves with the id of the tapped item, or `null` if the user dismissed
 * the menu without picking anything. Implemented by the
 * `tauri-plugin-native-chrome` plugin (see
 * `ios/Sources/NativeChromePlugin.swift`) — deliberately generic surface,
 * not chat-message-specific: any future feature that needs a native menu on
 * iOS reuses the same command.
 */
export async function showNativeContextMenu(items: NativeMenuItem[], point: { x: number; y: number }): Promise<string | null> {
  const result = await invoke<{ selectedId: string | null }>("plugin:native-chrome|show_context_menu", { items, point });
  return result.selectedId;
}
