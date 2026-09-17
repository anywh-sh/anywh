/** The slice of a `KeyboardEvent` these decisions read, so they can be
 * unit-tested with a plain object instead of a synthetic DOM event — same
 * shape `matchShortcut` (useKeyboardShortcuts.ts) already uses. */
type TerminalKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

function isPlainCtrl(event: TerminalKeyEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

/**
 * Plain Ctrl+V. By default xterm treats Ctrl+<letter> as a control character
 * for the shell (here 0x16 — readline/vim's "quoted insert") and cancels the
 * native keydown; on Chromium/WebView2 that suppresses the default paste
 * action, so the `paste` event never fires. Handing this specific keydown
 * back to the browser restores the native paste (Ctrl+Shift+V never went
 * through this path, and neither does Cmd+V on macOS — it uses `metaKey`).
 */
export function isNativePasteShortcut(event: TerminalKeyEvent): boolean {
  return isPlainCtrl(event) && event.key.toLowerCase() === "v";
}

/**
 * Whether Ctrl+C should copy the selection instead of sending SIGINT.
 *
 * The gate is the selection, never a timer: with nothing selected — the state
 * the terminal is in while a command runs — this is `false` and the `\x03`
 * goes out exactly as before, so interrupting a process is untouched. Copying
 * clears the selection (and so does typing), which is what gives the "press
 * it twice" escape hatch for the one case that does change: text selected
 * while a command is still running. That's the rule VS Code, Windows Terminal
 * and iTerm all use; a double-press window would add a deadline to miss
 * without buying anything.
 *
 * macOS is excluded on purpose. There Cmd+C already copies (xterm's own
 * `copy` handler picks it up, no `ctrlKey` involved) and Ctrl+C is expected
 * to interrupt unconditionally — taking it over would break the platform
 * convention to fix a problem macOS doesn't have.
 */
export function shouldCopySelection(event: TerminalKeyEvent, hasSelection: boolean, isMac: boolean): boolean {
  if (isMac) return false;
  return hasSelection && isPlainCtrl(event) && event.key.toLowerCase() === "c";
}
