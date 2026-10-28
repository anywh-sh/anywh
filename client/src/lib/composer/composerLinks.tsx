import type { JSONContent } from "@tiptap/core";

/** Zero-width character that `Composer.tsx` (`hardBreakAnchorPlugin`)
 * injects as real text after consecutive `hardBreak`s, just to give the
 * browser a valid layout box to anchor the cursor to (real bug, confirmed
 * via Playwright/Chromium — without this the cursor "jumps up" a line on
 * screens with 2+ consecutive breaks with no text between them). Purely
 * cosmetic, should never survive into the sent message. `U+FEFF`
 * (zero-width no-break space, the same choice Slate.js made for the same
 * problem) instead of `U+200B` (zero-width space) — not because one worked
 * and the other didn't (tested in the iOS Simulator: neither
 * one alone fixed it; the real root cause was something else, see
 * `Composer.tsx`), but because it's the more battle-tested option in other
 * editors for this kind of anchor. Exported (not just local) because
 * `Composer.tsx` needs the same character to insert the anchor — duplicating
 * the literal across both files is how this bug went unnoticed the first
 * time. */
export const HARD_BREAK_ANCHOR = "﻿";
const HARD_BREAK_ANCHOR_REGEX = new RegExp(HARD_BREAK_ANCHOR, "g");

function serializeInline(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type !== "text") return "";
  const text = (node.text ?? "").replace(HARD_BREAK_ANCHOR_REGEX, "");
  const linkMark = node.marks?.find((mark) => mark.type === "link");
  const href = linkMark?.attrs?.href as string | undefined;
  return href ? `[${text}](${href})` : text;
}

function serializeBlock(node: JSONContent): string {
  if (node.type !== "paragraph" || !node.content) return "";
  return node.content.map(serializeInline).join("");
}

/** Serializes the Tiptap doc (only paragraph(s) with text/hardBreak/link,
 * given the composer's restricted schema) into the plain text sent over the
 * wire. A link goes out as markdown, `[text](url)`, which the sent message's
 * bubble renders back into a link (`MarkdownContent`). */
export function serializeEditorContent(doc: JSONContent): string {
  return (doc.content ?? []).map(serializeBlock).join("\n\n");
}

/** What `.trim()` would do to the composer's text, minus eating the first
 * line's indentation: drops blank lines at the start and all trailing
 * whitespace, so a pasted indented snippet arrives as it was copied. A text
 * of only whitespace still comes out empty. */
export function trimComposerText(text: string): string {
  return text.replace(/^(?:[^\S\n]*\n)+/, "").trimEnd();
}
