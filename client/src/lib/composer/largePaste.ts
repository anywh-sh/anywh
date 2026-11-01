// A paste this big becomes an attachment instead of text in the composer:
// pasted instructions or a log would otherwise flood the field. Either bound
// is enough on its own — many short lines flood it as much as one long one.
export const LARGE_PASTE_MIN_CHARS = 500;
export const LARGE_PASTE_MIN_LINES = 12;

const NAME_MAX_CHARS = 40;

/** A readable name for the file a large paste becomes: its first line with
 * text, reduced to a lowercase slug (`# Deploy checklist` → `deploy-checklist.txt`).
 * Letters and digits of any script are kept, since the name rides into the
 * message the agent reads and says what the paste is about. A paste with no
 * usable first line is `pasted-text.txt`. `taken` are the names already
 * attached, so two pastes of one message never share a name (`-2`, `-3`…). */
export function pastedTextName(text: string, taken: readonly string[] = []): string {
  const firstLine = text.split("\n").find((line) => /[\p{L}\p{N}]/u.test(line)) ?? "";
  const words = firstLine
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Too long: cut at a word boundary when there is one, not mid-word.
  const cut = words.slice(0, NAME_MAX_CHARS);
  const boundary = cut.lastIndexOf("-");
  const slug = (words.length > NAME_MAX_CHARS && boundary >= NAME_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
  const base = slug || "pasted-text";
  let name = `${base}.txt`;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${String(n)}.txt`;
  return name;
}

export function isLargePaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_MIN_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++lines >= LARGE_PASTE_MIN_LINES) return true;
  }
  return false;
}
