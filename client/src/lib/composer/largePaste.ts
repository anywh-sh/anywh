// A paste this big becomes an attachment instead of text in the composer:
// pasted instructions or a log would otherwise flood the field. Either bound
// is enough on its own — many short lines flood it as much as one long one.
export const LARGE_PASTE_MIN_CHARS = 1000;
export const LARGE_PASTE_MIN_LINES = 25;

let pastedTexts = 0;

/** Name of the file a large paste becomes. Fixed English, not localized: it
 * rides into the message the agent reads, and the index keeps two pastes of
 * one message apart. */
export function nextPastedTextName(): string {
  return `pasted-text-${String(++pastedTexts)}.txt`;
}

export function isLargePaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_MIN_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++lines >= LARGE_PASTE_MIN_LINES) return true;
  }
  return false;
}
