import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDict } from "@/i18n";
import { mediaFileName, type ChatMediaItem } from "@/lib/media/chatMedia";
import { createRelayMediaSource, type ChatMediaSource } from "@/lib/media/relayMediaSource";
import { isIOS } from "@/lib/platform/platform";
import { dismissDownloadNotification, finishDownload, reportDownloadBytes, startFileDownload } from "@/lib/platform/downloadNotifications";
import type { Profile } from "@/lib/profiles/profiles";
import { downloadChatMedia, isAbortError } from "@/lib/relay/fileDownload";

/** The relay-backed source and download for a session's chat. The source is
 * remade only when the relay or the session changes — its object URLs are
 * freed then — while the profile it reads is always the latest one. */
export function useRelayChatMedia(profile: Profile, sessionId: string): { source: ChatMediaSource; onDownload?: (item: ChatMediaItem) => void } {
  const dict = useDict();
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const errorRef = useRef(dict.chat.media.viewer.downloadFailed);
  errorRef.current = dict.chat.media.viewer.downloadFailed;

  const source = useMemo(
    () => createRelayMediaSource(() => profileRef.current, sessionId),
    // `profile` is a fresh object on most renders; its id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile.id, sessionId],
  );
  useEffect(() => () => source.dispose(), [source]);

  const download = useCallback(
    (item: ChatMediaItem) => {
      const controller = new AbortController();
      let jobId: string | null = null;
      downloadChatMedia(profileRef.current, sessionId, item.path, {
        signal: controller.signal,
        onStart: () => {
          jobId = startFileDownload(mediaFileName(item.path), 0, () => controller.abort());
        },
        onBytes: (received, total) => {
          if (jobId !== null) reportDownloadBytes(jobId, received, total);
        },
      }).then(
        () => {
          if (jobId !== null) finishDownload(jobId);
        },
        (error: unknown) => {
          // Cancelled from the toast, which already removed itself.
          if (isAbortError(error)) return;
          if (jobId !== null) dismissDownloadNotification(jobId);
          console.error("[anywh] failed to download a chat media file:", item.path, error);
          window.alert(errorRef.current);
        },
      );
    },
    [sessionId],
  );

  return { source, onDownload: isIOS() ? undefined : download };
}
