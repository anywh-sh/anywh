// Opening one task in a bot's side panel from its conversation: a line like
// "Asked you about task #2" asks for it here. The panel — which may only
// mount once the pane (or, compact, the sheet) opens — takes the request and
// shows that task instead of the list; whoever hosts the panel is told, so
// it can bring it on screen.

const pending = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** Asks the panel of the bot whose room is `roomId` to show task `n`. */
export function askPanelTask(roomId: string, n: number): void {
  pending.set(roomId, n);
  for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
}

/** The task asked for the room's panel, once: `undefined` after. */
export function takePanelTask(roomId: string): number | undefined {
  const n = pending.get(roomId);
  pending.delete(roomId);
  return n;
}

/** Told on each request for the room's panel (without taking it). */
export function onPanelTask(roomId: string, listener: () => void): () => void {
  const set = listeners.get(roomId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(roomId, set);
  return () => set.delete(listener);
}
