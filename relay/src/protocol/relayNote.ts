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

/** The text without a relay note; unchanged unless it ENDS with the marker
 * followed by exactly one of the notes the relay adds. */
export function stripRelayNote(text: string): string {
  for (const note of KNOWN_NOTES) {
    const tail = `${RELAY_NOTE_MARKER}${note}`;
    if (text.endsWith(tail)) return text.slice(0, -tail.length);
  }
  return text;
}
