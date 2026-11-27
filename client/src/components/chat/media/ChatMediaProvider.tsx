import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDict } from "@/i18n";
import type { ChatMediaItem } from "@/lib/media/chatMedia";
import { mediaFileName } from "@/lib/media/chatMedia";
import { createRelayMediaSource, type ChatMediaSource } from "@/lib/media/relayMediaSource";
import { isIOS } from "@/lib/platform/platform";
import { dismissDownloadNotification, finishDownload, reportDownloadBytes, startFileDownload } from "@/lib/platform/downloadNotifications";
import type { Profile } from "@/lib/profiles/profiles";
import { downloadChatMedia, isAbortError } from "@/lib/relay/fileDownload";
import { ChatMediaContext, type ChatMediaHandle } from "@/components/chat/media/chatMediaContext";
import { MediaViewer } from "@/components/chat/media/MediaViewer";

interface ChatMediaProviderProps {
  source: ChatMediaSource;
  /** Saves a file on this device; absent where the app can't (iOS). */
  onDownload?: (item: ChatMediaItem) => void;
  children: ReactNode;
}

/** Gives the tiles of a conversation their bytes and the one viewer they
 * open. One per chat panel: the viewer belongs to the conversation, not to
 * whichever message happened to open it, so it survives that message
 * scrolling out of the virtualized log. */
export function ChatMediaProvider({ source, onDownload, children }: ChatMediaProviderProps) {
  const [viewer, setViewer] = useState<{ items: ChatMediaItem[]; index: number } | null>(null);
  const handle = useMemo<ChatMediaHandle>(() => ({ source, open: (items, index) => setViewer({ items, index }) }), [source]);

  return (
    <ChatMediaContext.Provider value={handle}>
      {children}
      {viewer && (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          source={source}
          onIndexChange={(index) => setViewer((open) => (open ? { ...open, index } : open))}
          onClose={() => setViewer(null)}
          onDownload={onDownload}
        />
      )}
    </ChatMediaContext.Provider>
  );
}

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
