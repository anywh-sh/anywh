import { looksLikeExternalUrl } from "@/lib/composer/filePathLinks";

// The images and videos a conversation shows inline — what the relay's
// `/files/media` serves (relay/src/fs/chatMedia.ts, whose extension list this
// mirrors: a file it would refuse never gets a tile here).

export type ChatMediaKind = "image" | "video";

/** One image or video as the viewer walks through them. `poster` is an
 * image standing in for a video until it plays (a sent video's first
 * extracted frame). */
export interface ChatMediaItem {
  path: string;
  kind: ChatMediaKind;
  alt?: string;
  poster?: string;
}

const KIND_BY_EXT: Readonly<Record<string, ChatMediaKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  svg: "image",
  heic: "image",
  heif: "image",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
};

export function chatMediaKind(path: string): ChatMediaKind | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return KIND_BY_EXT[name.slice(dot + 1).toLowerCase()];
}

/** The last segment, for a caption or a download's default name. */
export function mediaFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The local path a Markdown image's `src` names, or `undefined` when it names
 * something to fetch from elsewhere (`https://`, `data:`, `blob:`). The
 * parser percent-encodes a destination (`</tmp/my shot.png>` arrives as
 * `/tmp/my%20shot.png`), so the path is decoded back; a `file://` URL is
 * reduced to its path.
 */
export function localMediaPath(src: string | undefined): string | undefined {
  const value = src?.trim();
  if (!value) return undefined;
  if (/^file:\/\//i.test(value)) {
    try {
      return decode(new URL(value).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  if (looksLikeExternalUrl(value) || /^(data|blob|javascript|vbscript):/i.test(value)) return undefined;
  return decode(value);
}

/** An inline `data:` image the model wrote out in full — shown as is, since
 * displaying it fetches nothing. */
export function isInlineDataImage(src: string | undefined): boolean {
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(src?.trim() ?? "");
}
