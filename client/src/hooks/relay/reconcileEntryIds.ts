import type { LogEntry } from "./useMessageLog";

/**
 * What makes two entries "the same one" across two folds of the history.
 *
 * Ids are random UUIDs minted on every fold, and the virtualizer keys its
 * measured row heights by them, so a rehydration that keeps every entry but
 * changes every id makes each row fall back to its estimate and get measured
 * again — a visible layout shift. Identity is content, not position: the
 * relay's `history` and the live event stream don't line up one to one
 * (silent events, edits, `/clear` from another device).
 *
 * Fields that differ between the optimistic copy of an entry and its replayed
 * one are left out on purpose: a user message sent from this device carries
 * the click time, the replayed one the relay's timestamp.
 */
function identity(entry: LogEntry): string {
  switch (entry.kind) {
    case "user":
    case "text":
      return `${entry.kind}\0${entry.text}`;
    case "tool-call":
      return `tool-call\0${entry.toolUseId ?? `${entry.name}\0${JSON.stringify(entry.input)}`}`;
    case "thinking":
      return `thinking\0${entry.startedAt ?? ""}\0${entry.text}`;
    case "error":
      return `error\0${entry.message}`;
    case "background-job-note":
      return `background-job-note\0${entry.label}`;
    case "bot-note":
      return `bot-note\0${entry.label}`;
    case "turn-footer":
      return `turn-footer\0${entry.text}`;
    case "stopped":
    case "wakeup-note":
      return entry.kind;
  }
}

/**
 * Returns `next` with each entry's id replaced by the id of the entry in
 * `prev` that stands for the same thing. Matching goes left to right through a
 * queue of ids per identity, so repeated content (two identical "ok" replies)
 * keeps its ids in order instead of swapping them. An entry with no
 * counterpart keeps its own fresh id.
 */
export function reconcileEntryIds(prev: LogEntry[], next: LogEntry[]): LogEntry[] {
  if (prev.length === 0) return next;
  const queues = new Map<string, string[]>();
  for (const entry of prev) {
    const key = identity(entry);
    const queue = queues.get(key);
    if (queue) queue.push(entry.id);
    else queues.set(key, [entry.id]);
  }
  return next.map((entry) => {
    const id = queues.get(identity(entry))?.shift();
    return id === undefined || id === entry.id ? entry : { ...entry, id };
  });
}
