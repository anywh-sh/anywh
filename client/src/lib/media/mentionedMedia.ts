import { looksLikeFilePath } from "@/lib/composer/filePathLinks";
import { chatMediaKind, localMediaPath, type ChatMediaItem } from "@/lib/media/chatMedia";

/** At most this many previews under one message: a reply that lists a
 * folder of assets stays a reply, not a contact sheet. The rest are still
 * a click away, as path links. */
export const MAX_MENTIONED_MEDIA = 6;

/** A fenced code block, which can hold anything that looks like a path
 * without meaning one (`` ``` `` or `~~~`, closed by the same fence). */
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
/** Where a Markdown image points (`![alt](dest)`, `dest` bare or in `<>`). */
const IMAGE_DESTINATION = /!\[[^\]]*\]\(\s*(<[^>\n]+>|[^)\s]+)/g;
/** A single-backtick inline code span. */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/**
 * The images and videos a reply names as inline code without embedding
 * them (`` `/tmp/sim/home.png` ``, `` `rocket-blue.svg` ``), in the order it
 * names them — what the chat previews under the reply, so a file the agent
 * made or captured is seen even when it only says where it put it (measured:
 * an agent that writes several files tends to list their names and stop).
 * A file the reply already embeds, by its path or by a name that ends it, is
 * left out, and so is anything inside a fenced code block.
 */
export function mentionedMedia(markdown: string): ChatMediaItem[] {
  const text = markdown.replace(FENCED_BLOCK, "");
  const embedded = [...text.matchAll(IMAGE_DESTINATION)].flatMap((match) => {
    const path = localMediaPath(match[1].replace(/^<|>$/g, ""));
    return path ? [path] : [];
  });
  const isEmbedded = (path: string): boolean => embedded.some((shown) => shown === path || shown.endsWith(`/${path.replace(/^\.\//, "")}`));

  const found: ChatMediaItem[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_CODE)) {
    const path = match[1];
    if (!looksLikeFilePath(path) || seen.has(path)) continue;
    const kind = chatMediaKind(path);
    if (!kind || isEmbedded(path)) continue;
    seen.add(path);
    found.push({ path, kind });
    if (found.length === MAX_MENTIONED_MEDIA) break;
  }
  return found;
}
