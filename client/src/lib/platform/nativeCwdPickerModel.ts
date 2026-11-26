import type { Dictionary } from "@/i18n/dictionary";
import { ancestorsOf, displayPath, folderName, isHiddenFolder, parentOf } from "@/lib/files/folderPath";
import type { NativeCwdFolder, NativeCwdFolderRef, NativeCwdNotice, NativeCwdPickerPayload } from "@/lib/platform/nativeCwdPicker";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";
import type { FsEntry } from "@/lib/relay/fsBrowse";

/** Why the relay couldn't list a folder: its own error codes from
 * `GET /fs/list`, plus `unreachable` for a request that never got an answer. */
export type CwdListError = "permission_denied" | "not_found" | "not_a_directory" | "invalid_path" | "unreachable";

const LIST_ERRORS: readonly CwdListError[] = ["permission_denied", "not_found", "not_a_directory", "invalid_path"];

/** Reads what `listDirectories` threw: the relay's error code as the message,
 * or anything else (no answer, an HTTP status) as `unreachable`. */
export function listErrorOf(error: unknown): CwdListError {
  const message = error instanceof Error ? error.message : String(error);
  return LIST_ERRORS.find((code) => code === message) ?? "unreachable";
}

/** One folder's listing as the web side keeps it. */
export interface CwdListing {
  status: "loading" | "ready" | "error";
  entries: FsEntry[];
  error: CwdListError | null;
}

/** Where a typed path stands. `path` is the folder the relay confirmed, or
 * the path that was looked up when it wasn't found. */
export interface CwdLookupState {
  query: string;
  status: "checking" | "found" | "missing";
  path: string | null;
  error: CwdListError | null;
}

export interface CwdPickerModelInput {
  dict: Dictionary;
  theme: NativeShellTheme;
  /** The conversation the picker belongs to. */
  key: string;
  /** The conversation's folder. */
  cwd: string;
  /** The home folder on the relay's machine, once known. */
  home: string | null;
  /** The profile's recent folders, most recent first. */
  recents: string[];
  listings: Record<string, CwdListing>;
  lookup: CwdLookupState | null;
  flash: number;
}

/** `template` with every `{key}` replaced by `value`. Not `String.replace`,
 * which reads `$&` and friends in a folder name as patterns. */
function fill(template: string, key: string, value: string): string {
  return template.split(`{${key}}`).join(value);
}

/**
 * Everything the iOS capsule and the native working directory sheet draw,
 * worded and translated here so the native side holds no copy: folder names,
 * paths as shown (`~` for the home folder), which subfolders are hidden ones,
 * the "Up to …" and "Open …" rows, and every error in the user's words.
 */
export function buildCwdPickerPayload(input: CwdPickerModelInput): NativeCwdPickerPayload {
  const { dict, home } = input;
  const copy = dict.shell.cwdPicker;

  const ref = (path: string): NativeCwdFolderRef => ({ path, name: folderName(path), display: displayPath(path, home) });

  const readNotice = (error: CwdListError): NativeCwdNotice => ({
    title: copy.readErrorTitle,
    message:
      error === "permission_denied"
        ? copy.readError.permissionDenied
        : error === "not_found"
          ? copy.readError.notFound
          : error === "not_a_directory"
            ? copy.readError.notADirectory
            : error === "invalid_path"
              ? copy.readError.invalidPath
              : copy.readError.unreachable,
  });

  const folders: Record<string, NativeCwdFolder> = {};
  for (const [path, listing] of Object.entries(input.listings)) {
    const parent = path === "/" ? null : parentOf(path);
    folders[path] = {
      status: listing.status,
      parent: parent === null ? null : ref(parent),
      upLabel: parent === null ? null : fill(copy.upTo, "name", folderName(parent)),
      entries: listing.entries.map((entry) => ({
        path: entry.path,
        name: entry.name,
        display: displayPath(entry.path, home),
        hidden: isHiddenFolder(entry.name),
      })),
      error: listing.status === "error" ? readNotice(listing.error ?? "unreachable") : null,
    };
  }

  const lookup = input.lookup;
  const lookupTarget =
    lookup?.status === "found" && lookup.path !== null
      ? { ...ref(lookup.path), openLabel: fill(copy.open, "name", folderName(lookup.path)), chain: ancestorsOf(lookup.path).map(ref) }
      : null;
  let lookupError: NativeCwdNotice | null = null;
  if (lookup?.status === "missing") {
    const error = lookup.error ?? "not_found";
    // A typed path that leads nowhere reads as "not found"; one the relay
    // can't reach or read keeps the listing's own wording.
    if (error === "not_found") {
      lookupError = { title: copy.notFoundTitle, message: fill(copy.notFoundMessage, "path", lookup.path ? displayPath(lookup.path, home) : lookup.query) };
    } else if (error === "not_a_directory" || error === "invalid_path") {
      lookupError = { title: copy.notFoundTitle, message: readNotice(error).message };
    } else {
      lookupError = readNotice(error);
    }
  }

  return {
    key: input.key,
    capsule: { name: folderName(input.cwd), accessibilityLabel: fill(copy.capsuleLabel, "path", displayPath(input.cwd, home)) },
    flash: input.flash,
    current: ref(input.cwd),
    home: home === null ? null : ref(home),
    recents: input.recents.filter((path) => path !== input.cwd).map(ref),
    folders,
    lookup: lookup ? { query: lookup.query, status: lookup.status, target: lookupTarget, error: lookupError } : null,
    strings: {
      title: copy.title,
      close: dict.common.close,
      more: copy.more,
      searchPrompt: copy.searchPrompt,
      clearSearch: copy.clearSearch,
      recents: copy.recents,
      browseFromCurrent: copy.browseFromCurrent,
      subfolders: copy.subfolders,
      loading: copy.loading,
      emptyTitle: copy.emptyTitle,
      emptyMessage: copy.emptyMessage,
      noMatchTitle: copy.noMatchTitle,
      noMatchMessage: copy.noMatchMessage,
      checking: copy.checking,
      retry: copy.retry,
      selected: copy.selected,
      useFolder: copy.useFolder,
      alreadyCurrent: copy.alreadyCurrent,
      showHidden: dict.shell.folderPicker.showHidden,
      goHome: copy.goHome,
    },
    theme: input.theme,
  };
}
