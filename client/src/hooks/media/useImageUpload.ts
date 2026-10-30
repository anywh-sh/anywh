import { useCallback, useMemo, useState } from "react";
import { uploadAttachment } from "@/lib/relay/imageUpload";
import { captureVideoFrame } from "@/lib/videoPreview";
import { useDict } from "@/i18n";
import type { Profile } from "@/lib/profiles/profiles";

export interface PendingAttachment {
  kind: "image" | "video";
  /** Image: path of the image itself. Video: path of the original video —
   * stays referenced in the message alongside the frames, in case Claude
   * needs to run ffmpeg/ffprobe on it via Bash for something more specific. */
  path: string;
  /** Absent only when the preview fails (e.g. video with a codec the
   * browser's `<video>` can't decode) — UI falls back to a generic icon. */
  previewUrl?: string;
  /** Video only: paths of the frames extracted on the relay, in
   * chronological order — this (not the video itself) is what becomes
   * `[imagem anexada]` in the message, since Claude only "sees" images via
   * `Read`, not video. */
  frames?: string[];
}

/** One file the composer took in, from the moment it was picked until it is
 * sent or removed. `id` is local and exists before the relay has answered,
 * so an in-flight file can be told apart from its neighbours. */
export type AttachmentEntry =
  | { id: string; status: "uploading"; name: string }
  | { id: string; status: "ready"; name: string; attachment: PendingAttachment };

export interface UseImageUploadResult {
  /** Every file taken in, in the order it was picked, uploading or not. */
  entries: AttachmentEntry[];
  /** The ready ones — what a send carries. */
  pending: PendingAttachment[];
  /** True while any file is still on its way to the relay. */
  uploading: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  remove: (path: string) => void;
  /** Empties the ready ones without revoking the object URLs — used when
   * sending, since the message in the log becomes the owner of those
   * previews. */
  clearWithoutRevoke: () => void;
}

let nextEntryId = 0;

export function useImageUpload(profile: Profile, onError: (message: string) => void): UseImageUploadResult {
  const dict = useDict();
  const [entries, setEntries] = useState<AttachmentEntry[]>([]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const attachable = Array.from(files).filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      if (attachable.length === 0) return;

      // Every file gets its entry up front, so `uploading` stays true until
      // the last one of every batch lands — two overlapping calls (a paste
      // while a drop is still uploading) can no longer re-enable send early.
      const batch = attachable.map((file) => ({ file, id: `attachment-${String(++nextEntryId)}` }));
      setEntries((prev) => [...prev, ...batch.map(({ file, id }) => ({ id, status: "uploading" as const, name: file.name }))]);

      for (const { file, id } of batch) {
        const isVideo = file.type.startsWith("video/");
        try {
          let previewUrl: string | undefined;
          if (isVideo) {
            // Best-effort: if the browser can't decode the codec, the
            // preview fails but the upload/frame extraction on the relay
            // (which uses ffmpeg, with much broader support) proceeds normally.
            try {
              previewUrl = await captureVideoFrame(file);
            } catch {
              previewUrl = undefined;
            }
          } else {
            previewUrl = URL.createObjectURL(file);
          }

          const result = await uploadAttachment(profile, file);
          const attachment: PendingAttachment = isVideo
            ? { kind: "video", path: result.path, previewUrl, frames: result.frames ?? [] }
            : { kind: "image", path: result.path, previewUrl };
          setEntries((prev) =>
            prev.map((entry) => (entry.id === id ? { id, status: "ready", name: entry.name, attachment } : entry)),
          );
        } catch (error) {
          setEntries((prev) => prev.filter((entry) => entry.id !== id));
          const template = isVideo ? dict.chat.composer.uploadFailedVideo : dict.chat.composer.uploadFailedImage;
          onError(template.replace("{reason}", error instanceof Error ? error.message : String(error)));
        }
      }
    },
    [profile, onError, dict],
  );

  const remove = useCallback((path: string) => {
    setEntries((prev) => {
      const target = prev.find((entry) => entry.status === "ready" && entry.attachment.path === path);
      if (target?.status === "ready" && target.attachment.previewUrl) URL.revokeObjectURL(target.attachment.previewUrl);
      return prev.filter((entry) => entry !== target);
    });
  }, []);

  const clearWithoutRevoke = useCallback(() => setEntries((prev) => prev.filter((entry) => entry.status !== "ready")), []);

  const pending = useMemo(
    () => entries.flatMap((entry) => (entry.status === "ready" ? [entry.attachment] : [])),
    [entries],
  );
  const uploading = entries.some((entry) => entry.status === "uploading");

  return { entries, pending, uploading, addFiles, remove, clearWithoutRevoke };
}
