/**
 * Draws the verb the turn indicator shows while a turn is in flight.
 *
 * Same idea as the Claude Code CLI's spinner, which swaps "Thinking…" for a
 * random verb on every operation. Drawn once per turn and held — the CLI
 * doesn't cycle, and a label that changed every second would pull the eye
 * back to a row that has nothing new to say.
 *
 * The list itself lives in the dictionary, not here: these are jokes shown
 * to the user, so they are translated copy like any other string, and the
 * two languages deliberately don't line up word for word.
 */
export function pickThinkingWord(words: readonly string[]): string {
  return words[Math.floor(Math.random() * words.length)];
}
