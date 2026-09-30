import { createContext, useContext, useSyncExternalStore } from "react";

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
  private readonly open = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  isOpen = (id: string): boolean => this.open.has(id);

  toggle = (id: string): void => {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    this.listeners.get(id)?.forEach((notify) => notify());
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
