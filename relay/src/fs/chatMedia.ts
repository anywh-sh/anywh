import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorFromErrno, resolveChatPath, type FilesError } from "./fsFiles.js";

// The images and videos a conversation shows inline: the agent's Markdown
// images, a media path it mentions, the user's own attachments coming back
// from history. Unlike the file panel's routes this is not rooted at the
// session's cwd: a simulator screenshot lands in /tmp and an attachment in
// the upload dir, so confining it to the cwd would leave out exactly the
// files it exists for. What bounds it instead is the kind of file: only an
// image or video extension, checked again on the real path a symlink
// resolves to, so a stray mention can't turn it into a reader of `.env`.
// Like `resolveWithinRoot`, a contract rather than a security boundary:
// whoever reaches the relay already has its terminal.

export type ChatMediaKind = "image" | "video";

/** Only what a webview can show: `.avi`/`.mkv` attachments are accepted
 * for upload (the agent reads their frames) but no `<video>` plays them. */
const MEDIA_BY_EXT: Readonly<Record<string, { mime: string; kind: ChatMediaKind }>> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".avif": { mime: "image/avif", kind: "image" },
  ".bmp": { mime: "image/bmp", kind: "image" },
  ".svg": { mime: "image/svg+xml", kind: "image" },
  ".heic": { mime: "image/heic", kind: "image" },
  ".heif": { mime: "image/heif", kind: "image" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".m4v": { mime: "video/x-m4v", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
};

export function chatMediaOf(path: string): { mime: string; kind: ChatMediaKind } | undefined {
  return MEDIA_BY_EXT[extname(path).toLowerCase()];
}

export type ChatMediaResult =
  | { ok: true; path: string; mime: string; kind: ChatMediaKind; size: number; mtimeMs: number }
  | { ok: false; error: FilesError | "not_media" };

/** A path as the agent wrote it, made absolute: a `file://` URL, `~/...`
 * against the profile's home, an absolute path as is. A relative one is
 * tried against the session's cwd first and then through the same suffix
 * search a path mentioned in chat gets (`resolveChatPath`), so a bare
 * `login.png` still finds `screenshots/login.png`. `undefined` when the
 * text is no path at all. */
function absoluteFor(written: string, cwd: string, home: string): string | undefined {
  if (written.startsWith("file://")) {
    try {
      return fileURLToPath(written);
    } catch {
      return undefined;
    }
  }
  if (written === "~" || written.startsWith("~/")) return join(home, written.slice(1));
  if (isAbsolute(written)) return resolve(written);
  const joined = resolve(cwd, written);
  if (existsSync(joined)) return joined;
  return resolveChatPath(cwd, written).target ?? joined;
}

export function resolveChatMedia(rawPath: string, cwd: string, home: string): ChatMediaResult {
  const written = rawPath.trim();
  if (!written || written.includes("\0")) return { ok: false, error: "invalid_path" };
  const candidate = absoluteFor(written, cwd, home);
  if (!candidate) return { ok: false, error: "invalid_path" };
  // Refused before touching the disk when the name already says it isn't
  // media, and again on the real path below.
  if (!chatMediaOf(candidate)) return { ok: false, error: "not_media" };

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  const media = chatMediaOf(real);
  if (!media) return { ok: false, error: "not_media" };

  let stat;
  try {
    stat = statSync(real);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };
  return { ok: true, path: real, mime: media.mime, kind: media.kind, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Inclusive byte offsets, as `Content-Range` writes them. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The single range of a `Range: bytes=...` header. WebKit won't play a
 * `<video>` from a server that ignores ranges, which is why this exists.
 * `undefined` means serve the whole file: no header, a unit other than
 * bytes, a malformed value, or several ranges at once (a media element never
 * asks for more than one, and answering a multi-range request with the whole
 * file is allowed). `null` means the range can't be satisfied: 416.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return undefined;
  if (size === 0) return null;
  if (startText === "") {
    // `bytes=-N`: the last N bytes.
    const length = Number(endText);
    if (length === 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (start >= size || start > end) return null;
  return { start, end };
}

/** Changes whenever the file is rewritten in place, which an agent does to
 * a screenshot it takes again under the same name. */
export function chatMediaEtag(media: { size: number; mtimeMs: number }): string {
  return `"${media.size.toString(16)}-${Math.floor(media.mtimeMs).toString(16)}"`;
}

/** Whether an `If-None-Match` header names `etag` (or is `*`); a weak
 * validator matches its strong twin, as it does for a GET. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}
