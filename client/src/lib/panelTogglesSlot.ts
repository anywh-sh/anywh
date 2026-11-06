/**
 * Each tab group's side panel rail publishes the node its pane buttons render
 * into, so the group's active conversation can portal the buttons in.
 *
 * The toggles need `cwd`, which only each tab's own `ChatPanel` has (it
 * arrives on that tab's own socket) and which is deliberately not lifted into
 * `App` — every mounted tab reporting its folder on connect would re-render
 * all of them. A portal target lets the panel that owns the value draw the
 * buttons without it ever leaving the panel.
 *
 * There is one rail (and so one set of buttons) per tab GROUP on screen, and a
 * split view can have several groups on screen at once, each with its own
 * active tab — so this is a slot per `groupId`, and each group's own active
 * tab may claim its group's slot. The rail is drawn by the active tab's dock,
 * so switching the active tab hands the group a new node: the old one is
 * released and the new one published, and whoever portals into it follows.
 */
const slots = new Map<string, HTMLElement>();
const listeners = new Map<string, Set<() => void>>();

function notify(groupId: string): void {
  for (const listener of listeners.get(groupId) ?? []) listener();
}

/** Publishes `node` as the group's slot; the returned function releases it,
 * which makes this a ref callback as it stands (React 19 calls what a ref
 * callback returns on unmount). Releasing only drops the node it published:
 * when one tab's dock replaces another's in the same commit, the new rail may
 * be published before the old one lets go, and must not be dropped with it. */
export function setPanelTogglesSlot(groupId: string, node: HTMLElement): () => void {
  if (slots.get(groupId) !== node) {
    slots.set(groupId, node);
    notify(groupId);
  }
  return () => {
    if (slots.get(groupId) !== node) return;
    slots.delete(groupId);
    notify(groupId);
  };
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
