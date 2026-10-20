// A note the relay adds to the prompt of one turn for the model alone (for
// example that an approval it was waiting for was withdrawn). It rides at the
// end of the prompt behind a marker so that what is shown to people (the
// broadcast `user_message`, and the history rebuilt from the agent's own
// transcript) can drop it again.
const RELAY_NOTE_MARKER = "\n\n[anywh-note] ";

/** Told to the model when an approval it was left waiting for is gone. */
export const WITHDRAWN_APPROVAL_NOTE = "(the pending approval request was withdrawn by the user; do not wait for it)";

// Only these are ever added, so only these are removed: a person's own text
// that happens to contain the marker must come back untouched.
const KNOWN_NOTES: readonly string[] = [WITHDRAWN_APPROVAL_NOTE];

export function withRelayNote(text: string, note: string): string {
  return `${text}${RELAY_NOTE_MARKER}${note}`;
}

/** Starts the note that tells a room agent of items added to the room's
 * context after it was born (the rest of it names the items). */
export const ROOM_CONTEXT_NOTE_PREFIX = "New in the room's context since you started:";

/** The text without the relay notes at its end; unchanged unless it ENDS
 * with the marker followed by exactly one of the notes the relay adds (or a
 * room-context notice, which names items). Several stacked notes all go. */
export function stripRelayNote(text: string): string {
  let current = text;
  for (;;) {
    const stripped = stripOne(current);
    if (stripped === current) return current;
    current = stripped;
  }
}

function stripOne(text: string): string {
  for (const note of KNOWN_NOTES) {
    const tail = `${RELAY_NOTE_MARKER}${note}`;
    if (text.endsWith(tail)) return text.slice(0, -tail.length);
  }
  const at = text.lastIndexOf(`${RELAY_NOTE_MARKER}${ROOM_CONTEXT_NOTE_PREFIX}`);
  if (at >= 0 && !text.slice(at + RELAY_NOTE_MARKER.length).includes("\n")) return text.slice(0, at);
  return text;
}
