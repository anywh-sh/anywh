import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Which rows of a chat are expanded, keyed by a stable entry id.
 *
 * Lives outside the components on purpose: the log is virtualized, so a row
 * scrolled out of view is unmounted, and state kept inside it would reset —
 * a group the user opened would be closed again when they scrolled back.
 * One instance per chat tab (`MessageLog` creates it); a row subscribes to
 * its own id only, so opening one row re-renders that row and nothing else.
 */
export class OpenState {
  // What the user chose, per id. A row nobody touched has no entry — which is
  // different from one they closed, and `useWorkOpen` needs that difference.
  private readonly chosen = new Map<string, boolean>();
  private readonly listeners = new Map<string, Set<() => void>>();

  isOpen = (id: string): boolean => this.chosen.get(id) === true;

  /** The user's own choice, or `undefined` if they never made one. */
  choice = (id: string): boolean | undefined => this.chosen.get(id);

  set = (id: string, open: boolean): void => {
    this.chosen.set(id, open);
    this.listeners.get(id)?.forEach((notify) => notify());
  };

  toggle = (id: string): void => {
    this.set(id, !this.isOpen(id));
  };

  subscribe = (id: string, notify: () => void): (() => void) => {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(notify);
    return () => {
      set.delete(notify);
      if (set.size === 0) this.listeners.delete(id);
    };
  };
}

export const OpenStateContext = createContext<OpenState>(new OpenState());

/** `[open, toggle]` for one row, from the chat's shared `OpenState`. */
export function useOpen(id: string): [boolean, () => void] {
  const state = useContext(OpenStateContext);
  const open = useSyncExternalStore(
    (notify) => state.subscribe(id, notify),
    () => state.isOpen(id),
  );
  return [open, () => state.toggle(id)];
}

/** How long a finished turn's block stays open before it folds itself away —
 * long enough to see the last step land, short enough not to be in the way. */
export const WORK_LINGER_MS = 900;

/**
 * `[open, toggle]` for a turn's work block. Untouched, it follows the work:
 * open while the turn runs, folded `WORK_LINGER_MS` after it finishes. Once
 * the user opens or closes it themselves, that choice wins and the block
 * never moves on its own again.
 *
 * Only a block that was seen running lingers. One that mounts already
 * finished — history, or a block scrolled back into the virtualized list —
 * is folded from its first frame, with nothing to wait for.
 */
export function useWorkOpen(id: string, running: boolean): [boolean, () => void] {
  const state = useContext(OpenStateContext);
  const choice = useSyncExternalStore(
    (notify) => state.subscribe(id, notify),
    () => state.choice(id),
  );
  const [phase, setPhase] = useState<"live" | "lingering" | "settled">(running ? "live" : "settled");
  useEffect(() => {
    if (running) setPhase("live");
    else setPhase((current) => (current === "live" ? "lingering" : current));
  }, [running]);
  useEffect(() => {
    if (phase !== "lingering") return;
    const timer = setTimeout(() => setPhase("settled"), WORK_LINGER_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const open = choice ?? phase !== "settled";
  return [open, () => state.set(id, !open)];
}
