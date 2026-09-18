/**
 * Per-group counterpart to `titleBarSlot.ts` — same reasoning, see that
 * file's comment for the full argument. The files/terminal toggle buttons
 * need `cwd`, which only each tab's own `ChatPanel` has (it arrives on that
 * tab's own socket) and which is deliberately not lifted into `App` — every
 * mounted tab reporting its folder on connect would re-render all of them.
 *
 * This differs from `titleBarSlot` in one way: there is one title bar for
 * the whole app, but one strip (and so one toggle pair) per tab GROUP. A
 * split view can have several groups on screen at once, each with its own
 * active tab — so this is a slot per `groupId`, not a single one, and each
 * group's own active tab (not just the globally focused one) may claim its
 * group's slot. Switching the active tab inside a group hands that slot to
 * the new active tab's `ChatPanel` for free — the strip's own DOM node never
 * moves, only who portals into it changes.
 */
const slots = new Map<string, HTMLElement>();
const listeners = new Map<string, Set<() => void>>();

function notify(groupId: string): void {
  for (const listener of listeners.get(groupId) ?? []) listener();
}

/** Ref callback for a group strip's toggle slot element — React passes the
 * node on mount and `null` on unmount, which is exactly the contract here. */
export function setPanelTogglesSlot(groupId: string, node: HTMLElement | null): void {
  const current = slots.get(groupId) ?? null;
  if (current === node) return;
  if (node) slots.set(groupId, node);
  else slots.delete(groupId);
  notify(groupId);
}

export function getPanelTogglesSlot(groupId: string): HTMLElement | null {
  return slots.get(groupId) ?? null;
}

export function subscribePanelTogglesSlot(groupId: string, listener: () => void): () => void {
  let set = listeners.get(groupId);
  if (!set) {
    set = new Set();
    listeners.set(groupId, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}
