import type { PendingAttachment } from "@/hooks/media/useImageUpload";

/** A file name inside `[arquivo anexado (…): …]` must not be able to close
 * the bracket or the parenthesis and write its own instructions. */
function wireSafeName(name: string): string {
  return name.replace(/[[\]()\r\n]/g, "_");
}

export function buildWireMessage(text: string, attachments: PendingAttachment[]): string {
  // Claude only "sees" an image via `Read` — video becomes a sequence of
  // frames extracted on the relay (ffmpeg, `uploads.ts`), referenced in
  // chronological order, plus the original video's path in case it needs to
  // run ffmpeg/ffprobe on it directly via Bash for something more specific.
  // Any other file is read as is; its original name rides along, since the
  // relay saved it under a fresh id.
  const refs = attachments
    .map((attachment) => {
      if (attachment.kind === "file") {
        return attachment.name
          ? `[arquivo anexado (${wireSafeName(attachment.name)}): ${attachment.path}]`
          : `[arquivo anexado: ${attachment.path}]`;
      }
      if (attachment.kind !== "video") return `[imagem anexada: ${attachment.path}]`;
      if (!attachment.frames || attachment.frames.length === 0) {
        return `[vídeo anexado (sem preview de frames): ${attachment.path}]`;
      }
      const frameLines = attachment.frames
        .map((frame, index) => `[frame ${String(index + 1)}/${String(attachment.frames!.length)}: ${frame}]`)
        .join("\n");
      return `[vídeo anexado, ${String(attachment.frames.length)} frames extraídos em ordem cronológica (arquivo original: ${attachment.path})]\n${frameLines}`;
    })
    .join("\n");
  return [text, refs].filter(Boolean).join("\n\n");
}

const IMAGE_RE = /^\[imagem anexada: (.+)\]$/;
const NAMED_FILE_RE = /^\[arquivo anexado \(([^()]*)\): (.+)\]$/;
const FILE_RE = /^\[arquivo anexado: (.+)\]$/;
const VIDEO_NO_FRAMES_RE = /^\[vídeo anexado \(sem preview de frames\): (.+)\]$/;
const VIDEO_RE = /^\[vídeo anexado, \d+ frames extraídos em ordem cronológica \(arquivo original: (.+)\)\]$/;
const FRAME_RE = /^\[frame \d+\/\d+: (.+)\]$/;

function isMarkerLine(line: string): boolean {
  return [IMAGE_RE, NAMED_FILE_RE, FILE_RE, VIDEO_NO_FRAMES_RE, VIDEO_RE, FRAME_RE].some((re) => re.test(line));
}

/**
 * `buildWireMessage` backwards: a sent message as the relay hands it back
 * (history, or another device's send) split into what the person typed and
 * the attachments the markers at its end name — so the bubble shows the
 * files again instead of `[imagem anexada: /tmp/...]` lines. The markers
 * count only as the message's last block, after a blank line or as the whole
 * message, which is the one shape `buildWireMessage` writes; anything else
 * is text the person typed and stays as it is. A video's frames come back
 * as `frames`, the first of which stands in for its thumbnail.
 */
export function parseWireMessage(wire: string): { text: string; attachments: PendingAttachment[] } {
  const lines = wire.split("\n");
  let start = lines.length;
  while (start > 0 && isMarkerLine(lines[start - 1])) start--;
  if (start === lines.length || (start > 0 && lines[start - 1] !== "")) return { text: wire, attachments: [] };

  const attachments: PendingAttachment[] = [];
  for (const line of lines.slice(start)) {
    const frame = FRAME_RE.exec(line);
    if (frame) {
      const video = attachments[attachments.length - 1];
      if (video?.kind === "video") video.frames = [...(video.frames ?? []), frame[1]];
      continue;
    }
    const image = IMAGE_RE.exec(line);
    if (image) {
      attachments.push({ kind: "image", path: image[1] });
      continue;
    }
    const named = NAMED_FILE_RE.exec(line);
    if (named) {
      attachments.push({ kind: "file", path: named[2], name: named[1] });
      continue;
    }
    const file = FILE_RE.exec(line);
    if (file) {
      attachments.push({ kind: "file", path: file[1] });
      continue;
    }
    const video = VIDEO_RE.exec(line) ?? VIDEO_NO_FRAMES_RE.exec(line);
    if (video) attachments.push({ kind: "video", path: video[1] });
  }
  return { text: lines.slice(0, Math.max(0, start - 1)).join("\n"), attachments };
}
