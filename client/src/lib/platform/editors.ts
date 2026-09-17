import { invoke } from "@tauri-apps/api/core";
import type { EditorId } from "@/lib/platform/editorLinks";
import { inTauri } from "@/lib/platform/tauri";

export interface DetectedEditor {
  id: EditorId;
  label: string;
}

const KNOWN_EDITOR_IDS: readonly EditorId[] = ["zed", "vscode", "cursor", "windsurf"];

function isEditorId(value: string): value is EditorId {
  return (KNOWN_EDITOR_IDS as readonly string[]).includes(value);
}

let cached: Promise<DetectedEditor[]> | null = null;

/**
 * `detect_editors` (`editors.rs`) checks OS-level URL scheme registration —
 * a real filesystem/registry read, not just a PATH lookup — so it's worth
 * doing once per app session rather than on every file panel mount.
 * Cached at module scope (not React state) so every `FileTree` instance
 * across every session tab shares the same one-time detection. Outside
 * Tauri (`npm run dev` in a plain browser) resolves to an empty list
 * instead of throwing.
 */
export function detectEditors(): Promise<DetectedEditor[]> {
  if (!inTauri()) return Promise.resolve([]);
  cached ??= invoke<{ id: string; label: string }[]>("detect_editors")
    .then((editors) => editors.filter((editor): editor is DetectedEditor => isEditorId(editor.id)))
    .catch(() => []);
  return cached;
}
