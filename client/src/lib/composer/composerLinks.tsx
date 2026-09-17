import type { ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";

/**
 * Wire format for links created via paste-to-link in the composer:
 * `[text](url)` syntax — not generic markdown, just what
 * `serializeEditorContent` emits. `renderTextWithLinks` only recognizes this
 * specific pattern, never interprets arbitrary markdown the user may have
 * typed (italic, heading, list etc. remain plain text).
 */
const WIRE_LINK_REGEX = /\[([^\]]+)\]\(([a-zA-Z][a-zA-Z\d+.-]*:[^\s)]+)\)/g;

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
 * wire. */
export function serializeEditorContent(doc: JSONContent): string {
  return (doc.content ?? []).map(serializeBlock).join("\n\n");
}

/** Rebuilds links from the received plain text, to display in the sent
 * message's bubble — same `composer-link` visual class as the editor,
 * without depending on a full markdown parser (avoids reinterpreting
 * markdown the user may have happened to type as normal text). */
export function renderTextWithLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(WIRE_LINK_REGEX);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [full, label, href] = match;
    nodes.push(
      <a
        key={`link-${key++}`}
        href={href}
        rel="noopener noreferrer"
        className="composer-link"
        onClick={(event) => handleExternalLinkClick(event, href)}
      >
        {label}
      </a>,
    );
    lastIndex = match.index + full.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
