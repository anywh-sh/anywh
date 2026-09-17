import { useCallback, useState } from "react";
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

export interface UseImageUploadResult {
  pending: PendingAttachment[];
  uploading: boolean;
  addFiles: (files: FileList | File[]) => Promise<void>;
  remove: (path: string) => void;
  /** Empties the list without revoking the object URLs — used when
   * sending, since the message in the log becomes the owner of those
   * previews. */
  clearWithoutRevoke: () => void;
}

export function useImageUpload(profile: Profile, onError: (message: string) => void): UseImageUploadResult {
  const dict = useDict();
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const attachable = Array.from(files).filter(
        (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
      );
      if (attachable.length === 0) return;

      setUploading(true);
      try {
        for (const file of attachable) {
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
            setPending((prev) => [
              ...prev,
              isVideo
                ? { kind: "video" as const, path: result.path, previewUrl, frames: result.frames ?? [] }
                : { kind: "image" as const, path: result.path, previewUrl },
            ]);
          } catch (error) {
            const template = isVideo ? dict.chat.composer.uploadFailedVideo : dict.chat.composer.uploadFailedImage;
            onError(template.replace("{reason}", error instanceof Error ? error.message : String(error)));
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [profile, onError, dict],
  );

  const remove = useCallback((path: string) => {
    setPending((prev) => {
      const target = prev.find((item) => item.path === path);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.path !== path);
    });
  }, []);

  const clearWithoutRevoke = useCallback(() => setPending([]), []);

  return { pending, uploading, addFiles, remove, clearWithoutRevoke };
}
