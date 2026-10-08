import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { currentPlatform } from "@/lib/platform/platform";

// Tauri's native `onDragDropEvent` (ChatPanel.tsx, FilesPanel.tsx) types
// `position` as physical pixels, but only Windows (WebView2) really delivers
// them. wry's macOS handler (`draggingLocation()`) and its WebKitGTK handler
// (GTK widget coordinates) both report logical pixels and just wrap them in
// `PhysicalPosition` — dividing those by `devicePixelRatio` again halved the
// point on a Retina Mac, landing it over the chat instead of the file panel.
// `elementFromPoint`/`getBoundingClientRect` work in CSS/logical pixels, so
// only the Windows value needs converting; `window.devicePixelRatio` is the
// webview's own view of the scale factor, which avoids an extra async
// `getCurrentWindow().scaleFactor()` round trip per drag event.
export function physicalPositionToClientPoint(
  position: PhysicalPosition,
  platform: string | null = currentPlatform(),
  devicePixelRatio: number = window.devicePixelRatio,
): { x: number; y: number } {
  if (platform !== "windows") return { x: position.x, y: position.y };
  return { x: position.x / devicePixelRatio, y: position.y / devicePixelRatio };
}
