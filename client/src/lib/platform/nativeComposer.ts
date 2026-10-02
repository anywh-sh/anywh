import { addPluginListener, invoke } from "@tauri-apps/api/core";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";

export interface NativeComposerAttachment {
  /** Attachment id (its path on the relay), handed back on removal. */
  path: string;
  kind: "image" | "video";
  /** `data:image/jpeg;base64,…`, small; `null` draws a name chip instead. */
  thumbnail: string | null;
  /** Used by the chip only. */
  name: string;
}

export interface NativeComposerPayload {
  /** A web modal is open, or there is no chat tab. */
  hidden: boolean;
  placeholder: string;
  canSend: boolean;
  /** Swaps send for stop. */
  turnInFlight: boolean;
  attachEnabled: boolean;
  uploading: boolean;
  attachments: NativeComposerAttachment[];
  editBanner: { text: string; cancelLabel: string } | null;
  typo: { before: string; command: string; after: string; useLabel: string; sendAnywayLabel: string } | null;
  strings: {
    attach: string;
    attachPhotos: string;
    attachFiles: string;
    removeAttachment: string;
    uploading: string;
    send: string;
    stop: string;
    scrollToEnd: string;
  };
  theme: NativeShellTheme;
}

export interface NativeAttachedFile {
  path: string;
  name: string;
  mimeType: string;
}

/** Events the native composer sends back. Native only captures input and
 * draws; what each of these means is decided by the handlers. */
export interface NativeComposerHandlers {
  composerTextChange: (event: { text: string }) => void;
  composerFocusChange: (event: { focused: boolean }) => void;
  composerSubmit: (event: { text: string }) => void;
  composerStop: () => void;
  composerAttach: (event: { files: NativeAttachedFile[] }) => void;
  composerRemoveAttachment: (event: { path: string }) => void;
  composerCancelEdit: () => void;
  composerTypoUse: () => void;
  composerTypoSendAnyway: () => void;
  composerScrollToEnd: () => void;
}

export function setNativeComposer(payload: NativeComposerPayload): Promise<void> {
  return invoke("plugin:native-chrome|set_composer", { payload });
}

/** Imperative on purpose (not part of the payload): it must never overwrite
 * what the user is typing. The native side puts the cursor at the end. */
export function setNativeComposerText(text: string): Promise<void> {
  return invoke("plugin:native-chrome|set_composer_text", { payload: { text } });
}

export function focusNativeComposer(): Promise<void> {
  return invoke("plugin:native-chrome|focus_composer");
}

export function blurNativeComposer(): Promise<void> {
  return invoke("plugin:native-chrome|blur_composer");
}

/** The turn clock's label, already formatted; `null` clears it. */
export function setNativeComposerElapsed(label: string | null): Promise<void> {
  return invoke("plugin:native-chrome|set_composer_elapsed", { payload: { label } });
}

/** `accessoryHeight` is the web stack floating above the composer, so the
 * arrow sits above it instead of on top of it. */
export function setNativeScrollToEnd(visible: boolean, accessoryHeight: number): Promise<void> {
  return invoke("plugin:native-chrome|set_scroll_to_end", { payload: { visible, accessoryHeight } });
}

/** Reads (and deletes) a file the native picker copied aside. */
export async function readNativeAttachment(path: string): Promise<Uint8Array> {
  const bytes = await invoke<ArrayBuffer>("plugin:native-chrome|read_attachment", { payload: { path } });
  return new Uint8Array(bytes);
}

/** Subscribes to every native composer event. Resolves to one function that
 * removes them all. */
export async function listenNativeComposer(handlers: NativeComposerHandlers): Promise<() => void> {
  const names = Object.keys(handlers) as (keyof NativeComposerHandlers)[];
  const listeners = await Promise.all(
    names.map((name) => addPluginListener("native-chrome", name, (event: never) => (handlers[name] as (event: never) => void)(event))),
  );
  return () => {
    for (const listener of listeners) void listener.unregister();
  };
}
