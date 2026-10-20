// A note the relay adds to the prompt of one turn for the model alone (for
// example that an approval it was waiting for was withdrawn). It rides at the
// end of the prompt behind a marker so that what is shown to people (the
// broadcast `user_message`, and the history rebuilt from the agent's own
// transcript) can drop it again.
const RELAY_NOTE_MARKER = "\n\n[anywh-note] ";

export function withRelayNote(text: string, note: string): string {
  return `${text}${RELAY_NOTE_MARKER}${note}`;
}

/** The text without a relay note; unchanged when it has none. */
export function stripRelayNote(text: string): string {
  const at = text.indexOf(RELAY_NOTE_MARKER);
  return at === -1 ? text : text.slice(0, at);
}
