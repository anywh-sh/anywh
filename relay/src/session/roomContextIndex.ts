// The room's context is a folder; what every agent is handed at birth is not
// its content but one short index of it, so a room with a hundred pages of
// material costs each agent a page of prompt, not a hundred. This file only
// decides what an item looks like in that index and keeps the index inside a
// fixed budget. Reading the files is up to each agent, on demand.
//
// Pure: no I/O, so the format and the budget are testable as tables.
import { ROOM_CONTEXT_NOTE_PREFIX } from "../protocol/relayNote.js";

export type ContextItemKind = "text" | "pdf" | "image" | "binary";

export interface ContextItem {
  /** File name inside the room's folder (never a path). */
  name: string;
  kind: ContextItemKind;
  bytes: number;
  /** Lines of the text (of the extraction, for a PDF). */
  lines?: number;
  pages?: number;
  /** The file holding the text extracted once from a PDF. */
  extraction?: string;
  /** Who put it there: `user`, an agent's title, or `agent`/`unknown`. */
  author: string;
  /** One sentence on what it holds. */
  summary: string;
  /** Epoch ms when the relay learned of it. */
  at: number;
  /** Roughly this many tokens to read all of it; set only above the
   * warning threshold. */
  largeTokens?: number;
}

/** What the index may take in the prompt, measured in characters: 4 of them
 * are about a token, so this is about 1.5k tokens, under the 1-2k target. */
export const INDEX_MAX_CHARS = 6000;
/** An item above this many tokens is flagged: agents read it in parts. */
export const LARGE_ITEM_TOKENS = 20_000;
const SUMMARY_MAX = 110;
const NAME_MAX = 96;

/** The usual rough count: 4 characters to a token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** A one-line summary out of a text: its first line that says something,
 * without markdown heading marks, cut at a word. */
export function summarize(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s#>*\-=_`|]+/, "").replace(/\s+/g, " ").trim();
    if (line.length < 3) continue;
    if (line.length <= SUMMARY_MAX) return line;
    const cut = line.slice(0, SUMMARY_MAX);
    const space = cut.lastIndexOf(" ");
    return `${(space > SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return "";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function size(item: ContextItem): string {
  if (item.pages !== undefined) return `${item.pages} page${item.pages === 1 ? "" : "s"}`;
  if (item.lines !== undefined) return `${item.lines} line${item.lines === 1 ? "" : "s"}`;
  return item.bytes < 1024 ? `${item.bytes} B` : `${Math.round(item.bytes / 1024)} KB`;
}

function line(item: ContextItem): string {
  const parts = [`\`${clip(item.name, NAME_MAX)}\``, item.kind, size(item), clip(item.author, 60)];
  if (item.extraction) parts.splice(1, 0, `text in \`${clip(item.extraction, NAME_MAX)}\``);
  if (item.largeTokens !== undefined) parts.push(`LARGE (~${Math.round(item.largeTokens / 1000)}k tokens): read in parts`);
  if (item.summary) parts.push(clip(item.summary, SUMMARY_MAX));
  return `- ${parts.join(" · ")}`;
}

const HEADER = (dir: string): string =>
  `# Room context\n\nShared files of this room are in \`${dir}\`. Read them on demand (Grep, or Read with offset/limit; \`pages\` for a PDF); they are not pasted here. Only the relay edits this index.\n\n`;

/** The index of a room's folder, newest items last. Over the budget, the
 * oldest items drop out of the list (the folder still has them) and the
 * last line says how many. */
export function buildIndex(dir: string, items: readonly ContextItem[], maxChars = INDEX_MAX_CHARS): string {
  const header = HEADER(dir);
  if (items.length === 0) return `${header}(no items yet)\n`;
  const ordered = [...items].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  const lines = ordered.map(line);
  const more = (hidden: number): string => `- (+${hidden} older item${hidden === 1 ? "" : "s"} not listed; \`ls\` the folder)\n`;
  let start = 0;
  const body = (): string => lines.slice(start).join("\n");
  while (start < lines.length - 1 && header.length + (start > 0 ? more(start).length : 0) + body().length + 1 > maxChars) start++;
  return `${header}${start > 0 ? more(start) : ""}${body()}\n`;
}

/** The notice an agent already alive gets when items arrive after it was
 * born (its prompt is frozen, so it hears about them in a message). */

const CONTEXT_NOTE_PREFIX = ROOM_CONTEXT_NOTE_PREFIX;

export function buildNotice(items: readonly ContextItem[], limit = 5): string {
  const shown = items.slice(0, limit).map((item) => line(item).slice(2));
  const rest = items.length - shown.length;
  return `${CONTEXT_NOTE_PREFIX} ${shown.join("; ")}${rest > 0 ? `; and ${rest} more (see INDEX.md)` : ""}.`;
}
