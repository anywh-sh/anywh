import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDict } from "@/i18n";
import { useShellTheme } from "@/hooks/platform/useNativeShell";
import { useRecentFolders } from "@/hooks/useRecentFolders";
import { resolvePathQuery } from "@/lib/files/folderPath";
import { listenNativeCwdPicker, setNativeCwdPicker } from "@/lib/platform/nativeCwdPicker";
import { buildCwdPickerPayload, listErrorOf, type CwdListing, type CwdLookupState } from "@/lib/platform/nativeCwdPickerModel";
import type { Profile } from "@/lib/profiles/profiles";
import { listDirectories } from "@/lib/relay/fsBrowse";

interface NativeCwdPickerProps {
  profile: Profile;
  /** The conversation. It names the picker: an event made in another
   * conversation's sheet is dropped. */
  sessionId: string;
  cwd: string | null;
  locked: boolean;
  connected: boolean;
  /** Same rule as `WorkingDirectoryButton`: a new conversation's folder is
   * choosable before the connection opens (the pick waits in `RelayClient`);
   * an existing one's only once connected, when its lock is confirmed. */
  isNewConversation?: boolean;
  onSetCwd: (path: string) => void;
  /** A folder was picked and the sheet closed: the next step is the first
   * message. */
  onPicked?: () => void;
}

interface PickerState {
  /** Listings by path, while the sheet is open. */
  listings: Record<string, CwdListing>;
  lookup: CwdLookupState | null;
  /** The home folder on the relay's machine, once listed. */
  home: string | null;
  flash: number;
}

const INITIAL_STATE: PickerState = { listings: {}, lookup: null, home: null, flash: 0 };

/** How long a typed path rests before it is looked up on the relay. */
const LOOKUP_DELAY_MS = 250;

/**
 * iOS: the conversation's folder, while it can still be chosen, as a capsule
 * above the native composer that opens a native sheet (the `native-chrome`
 * plugin's `setCwdPicker`), in place of `WorkingDirectoryButton` and
 * `FolderPickerDialog`. Headless, like `NativeChoiceSheet`: this side lists
 * folders on the relay, looks typed paths up, keeps the recent folders and
 * sets the folder; the sheet owns where it is and reports it. Unmounting, or
 * the folder getting fixed, takes the capsule and the sheet away.
 *
 * Listings belong to one opening of the sheet: one that answers after the
 * sheet closed (or reopened) is dropped. A pick is applied once per opening,
 * since the sheet closes itself on it and a second one can only be a repeat.
 */
export function NativeCwdPicker({ profile, sessionId, cwd, locked, connected, isNewConversation, onSetCwd, onPicked }: NativeCwdPickerProps) {
  const dict = useDict();
  const theme = useShellTheme();
  const { recents, addRecent } = useRecentFolders(profile.id);

  const [state, setState] = useState<PickerState>(INITIAL_STATE);
  // Native events arrive back to back (open, then the first folder): each one
  // has to see what the previous one did, not the last render.
  const stateRef = useRef(state);
  const update = useCallback((change: (prev: PickerState) => PickerState) => {
    stateRef.current = change(stateRef.current);
    setState(stateRef.current);
  }, []);

  // Latest props for the native callbacks, which outlive any one render.
  const propsRef = useRef({ profile, sessionId, cwd, locked, onSetCwd, onPicked, addRecent });
  propsRef.current = { profile, sessionId, cwd, locked, onSetCwd, onPicked, addRecent };

  /** Bumped when the sheet opens or closes: a listing from before is stale. */
  const generationRef = useRef(0);
  const chosenRef = useRef(false);
  /** A picked folder the relay hasn't confirmed yet; the capsule flashes when
   * it does. */
  const pendingFlashRef = useRef<string | null>(null);
  const homeRef = useRef<Promise<string | null> | null>(null);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const choosable = !locked && cwd !== null && (Boolean(isNewConversation) || connected);

  const payload = useMemo(
    () =>
      choosable && cwd !== null
        ? buildCwdPickerPayload({
            dict,
            theme,
            key: sessionId,
            cwd,
            home: state.home,
            recents,
            listings: state.listings,
            lookup: state.lookup,
            flash: state.flash,
          })
        : null,
    [choosable, cwd, dict, theme, sessionId, state, recents],
  );

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    void setNativeCwdPicker(payload).catch(() => {});
  }, [payload]);

  // The capsule and the sheet belong to this panel: leaving takes them away.
  useEffect(
    () => () => {
      lastSentRef.current = null;
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      void setNativeCwdPicker(null).catch(() => {});
    },
    [],
  );

  // The folder a pick asked for is now the conversation's.
  useEffect(() => {
    if (cwd === null || cwd !== pendingFlashRef.current) return;
    pendingFlashRef.current = null;
    update((prev) => ({ ...prev, flash: prev.flash + 1 }));
  }, [cwd, update]);

  // Another conversation starts over; another profile's relay has its own
  // home folder.
  useEffect(() => {
    generationRef.current += 1;
    chosenRef.current = false;
    pendingFlashRef.current = null;
    update((prev) => ({ ...INITIAL_STATE, home: prev.home, flash: prev.flash }));
  }, [sessionId, update]);
  useEffect(() => {
    homeRef.current = null;
    update((prev) => ({ ...prev, home: null }));
  }, [profile.id, update]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const ours = (key: string): boolean => key === propsRef.current.sessionId;

    const setListing = (path: string, listing: CwdListing): void =>
      update((prev) => ({ ...prev, listings: { ...prev.listings, [path]: listing } }));

    /** Lists `path` for the open sheet, unless it is listed or being listed
     * already (`force`: "Try again"). A folder that failed waits for that. */
    const requestFolder = (path: string, force: boolean): void => {
      if (!force && stateRef.current.listings[path]) return;
      const generation = generationRef.current;
      setListing(path, { status: "loading", entries: [], error: null });
      listDirectories(propsRef.current.profile, path, true).then(
        (result) => {
          if (generation === generationRef.current) setListing(path, { status: "ready", entries: result.entries, error: null });
        },
        (error: unknown) => {
          if (generation === generationRef.current) setListing(path, { status: "error", entries: [], error: listErrorOf(error) });
        },
      );
    };

    /** The relay's default folder for the profile, which is its home: what
     * `~` means, and where "Go to the home folder" leads. Listed once. */
    const ensureHome = (): Promise<string | null> => {
      if (homeRef.current) return homeRef.current;
      const generation = generationRef.current;
      const pending = listDirectories(propsRef.current.profile, undefined, true).then(
        (result) => {
          update((prev) => ({
            ...prev,
            home: result.path,
            listings:
              generation === generationRef.current && !prev.listings[result.path]
                ? { ...prev.listings, [result.path]: { status: "ready", entries: result.entries, error: null } }
                : prev.listings,
          }));
          return result.path;
        },
        () => {
          homeRef.current = null;
          return null;
        },
      );
      homeRef.current = pending;
      return pending;
    };

    const lookUp = async (query: string, generation: number): Promise<void> => {
      const stillWanted = () => generation === generationRef.current && stateRef.current.lookup?.query === query;
      const home = query.startsWith("~") ? await ensureHome() : stateRef.current.home;
      if (!stillWanted()) return;
      const path = resolvePathQuery(query, home);
      if (path === null) {
        update((prev) => ({ ...prev, lookup: { query, status: "missing", path: null, error: "unreachable" } }));
        return;
      }
      try {
        const result = await listDirectories(propsRef.current.profile, path, true);
        if (!stillWanted()) return;
        update((prev) => ({
          ...prev,
          lookup: { query, status: "found", path: result.path, error: null },
          // Going there next shows it right away.
          listings: { ...prev.listings, [result.path]: { status: "ready", entries: result.entries, error: null } },
        }));
      } catch (error) {
        if (stillWanted()) update((prev) => ({ ...prev, lookup: { query, status: "missing", path, error: listErrorOf(error) } }));
      }
    };

    const forget = (): void => {
      generationRef.current += 1;
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      update((prev) => ({ ...prev, listings: {}, lookup: null }));
    };

    void listenNativeCwdPicker({
      cwdPickerOpen: ({ key }) => {
        if (!ours(key)) return;
        forget();
        chosenRef.current = false;
        void ensureHome();
      },
      cwdPickerFolder: ({ key, path }) => {
        if (ours(key)) requestFolder(path, false);
      },
      cwdPickerRetry: ({ key, path }) => {
        if (ours(key)) requestFolder(path, true);
      },
      cwdPickerLookup: ({ key, query }) => {
        if (!ours(key)) return;
        update((prev) => ({ ...prev, lookup: { query, status: "checking", path: null, error: null } }));
        if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
        const generation = generationRef.current;
        lookupTimerRef.current = setTimeout(() => void lookUp(query, generation), LOOKUP_DELAY_MS);
      },
      cwdPickerChoose: ({ key, path }) => {
        const current = propsRef.current;
        // The folder was fixed meanwhile (a message from another device), or
        // this is the second tap of a double tap: nothing to do.
        if (!ours(key) || current.locked || chosenRef.current) return;
        chosenRef.current = true;
        current.addRecent(path);
        if (path !== current.cwd) {
          pendingFlashRef.current = path;
          current.onSetCwd(path);
        }
        current.onPicked?.();
      },
      cwdPickerClose: ({ key }) => {
        if (ours(key)) forget();
      },
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [update]);

  return null;
}
