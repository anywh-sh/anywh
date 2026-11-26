import { invoke } from "@tauri-apps/api/core";
import { listenPluginEvents } from "@/lib/platform/pluginEvents";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";

/** A folder as the picker shows it. */
export interface NativeCwdFolderRef {
  path: string;
  name: string;
  /** The path as shown, with the home folder written `~`. */
  display: string;
}

/** One subfolder of a listed folder. */
export interface NativeCwdFolderEntry extends NativeCwdFolderRef {
  /** A dot-folder or `node_modules`: offered only with "Show hidden folders". */
  hidden: boolean;
}

/** A worded reason: a folder the relay couldn't list, a typed path it
 * couldn't find. */
export interface NativeCwdNotice {
  title: string;
  message: string;
}

/** One folder's subfolders, as the relay last listed them. */
export interface NativeCwdFolder {
  status: "loading" | "ready" | "error";
  /** The folder above, for the "Up to …" row; `null` at `/`. */
  parent: NativeCwdFolderRef | null;
  upLabel: string | null;
  /** Every subfolder, hidden ones included. */
  entries: NativeCwdFolderEntry[];
  error: NativeCwdNotice | null;
}

/** What the search field's typed path resolved to. */
export interface NativeCwdLookup {
  /** The text this answers: the sheet only shows it while the field still
   * holds exactly this. */
  query: string;
  status: "checking" | "found" | "missing";
  target: (NativeCwdFolderRef & { openLabel: string; chain: NativeCwdFolderRef[] }) | null;
  error: NativeCwdNotice | null;
}

/**
 * The working directory picker of a conversation whose folder can still be
 * chosen, as iOS draws it: a capsule above the native composer, and the
 * native sheet it opens. This side lists folders (on the relay's machine, not
 * the device), resolves typed paths and decides what a pick does; the native
 * side owns where the sheet is — its stack of folders, the search text,
 * whether hidden folders show — and reports it (`NativeCwdPickerHandlers`).
 */
export interface NativeCwdPickerPayload {
  /** Names the conversation. Every event carries it back, and an open sheet
   * closes when it changes. */
  key: string;
  capsule: { name: string; accessibilityLabel: string };
  /** Bumped when a folder picked in the sheet takes effect: the capsule
   * flashes. */
  flash: number;
  /** The conversation's folder: the sheet opens on it. */
  current: NativeCwdFolderRef;
  /** The home folder on the relay's machine, once known. */
  home: NativeCwdFolderRef | null;
  /** Recently used folders, the current one left out. */
  recents: NativeCwdFolderRef[];
  /** Listings by path, while the sheet is open. */
  folders: Record<string, NativeCwdFolder>;
  lookup: NativeCwdLookup | null;
  strings: {
    title: string;
    close: string;
    more: string;
    searchPrompt: string;
    /** Accessibility label of the search field's clear button. */
    clearSearch: string;
    recents: string;
    browseFromCurrent: string;
    subfolders: string;
    loading: string;
    emptyTitle: string;
    emptyMessage: string;
    /** Holds `{query}`, which the sheet replaces with the typed text. */
    noMatchTitle: string;
    noMatchMessage: string;
    checking: string;
    retry: string;
    selected: string;
    useFolder: string;
    alreadyCurrent: string;
    showHidden: string;
    goHome: string;
  };
  theme: NativeShellTheme;
}

/** What the native picker reports. Every event carries the `key` of the
 * conversation it was made in, so one that lands after the picker moved to
 * another conversation can be told apart. */
export interface NativeCwdPickerHandlers {
  /** The sheet opened. */
  cwdPickerOpen: (event: { key: string }) => void;
  /** A folder came on screen in the sheet: its listing is wanted. */
  cwdPickerFolder: (event: { key: string; path: string }) => void;
  /** "Try again" on a folder the relay couldn't list. */
  cwdPickerRetry: (event: { key: string; path: string }) => void;
  /** The search field holds a path (it starts with `/` or `~`). */
  cwdPickerLookup: (event: { key: string; query: string }) => void;
  /** A folder was picked (a recent one, or "Use this folder"); the sheet has
   * already closed itself. */
  cwdPickerChoose: (event: { key: string; path: string }) => void;
  /** The sheet closed. */
  cwdPickerClose: (event: { key: string }) => void;
}

/** `null` takes the capsule away and closes the sheet if it is open. */
export function setNativeCwdPicker(picker: NativeCwdPickerPayload | null): Promise<void> {
  return invoke("plugin:native-chrome|set_cwd_picker", { payload: { picker } });
}

/** Subscribes to every event of the native working directory picker.
 * Resolves to one function that removes them all. */
export function listenNativeCwdPicker(handlers: NativeCwdPickerHandlers): Promise<() => void> {
  return listenPluginEvents("native-chrome", handlers);
}
