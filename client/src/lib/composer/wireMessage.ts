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
