// A CLI writing to a pty writes for a terminal: colors, cursor moves, and
// clickable-link escapes. Anything that shows that output in plain DOM has
// to take them out first, or the user reads `[94m` and `]8;;` as if they
// were part of an authorization URL.
//
// Deliberately not a terminal emulator: the one place this is used shows a
// short, append-only log (`McpSignInDialog`), not a screen a CLI redraws.
// A component that ever needs redraw semantics should use the real
// terminal panel, which is xterm.js, rather than grow this.

// Two families, in one pass:
//   - CSI  `ESC [ … final-byte` — colors (`[94m`), cursor moves (`[1G`),
//     erase (`[0J`).
//   - OSC  `ESC ] … BEL` or `ESC ] … ESC \` — the hyperlink wrapper
//     (`ESC]8;;<url>BEL`), which *hides* a copy of the URL that would
//     otherwise be printed twice once the escapes are gone.
// Control characters are precisely what this matches — `no-control-regex`
// exists to catch them arriving in a pattern by accident, which is the
// opposite of the case here.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\][^]*(?:|\\)|\[[0-9;?]*[ -/]*[@-~]/g;

/** The same text with terminal escapes removed. Carriage returns are left
 * alone: a `\r\n` pair renders as one break in the DOM anyway, and a lone
 * `\r` is a CLI redrawing a line it wrote — dropping it would join two
 * lines into one, which reads worse than the stray character. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
