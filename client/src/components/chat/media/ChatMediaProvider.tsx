import { useMemo, useState, type ReactNode } from "react";
import type { ChatMediaItem } from "@/lib/media/chatMedia";
import type { ChatMediaSource } from "@/lib/media/relayMediaSource";
import { ChatMediaContext, type ChatMediaHandle } from "@/components/chat/media/chatMediaContext";
import { MediaViewer } from "@/components/chat/media/MediaViewer";

interface ChatMediaProviderProps {
  source: ChatMediaSource;
  /** Saves a file on this device; absent where the app can't (iOS). */
  onDownload?: (item: ChatMediaItem) => void;
  /** No media here (a relay that can't serve it): the messages render as
   * they do with no conversation around them, an image as its caption. */
  disabled?: boolean;
  children: ReactNode;
}

/** Gives the tiles of a conversation their bytes and the one viewer they
 * open. One per chat panel: the viewer belongs to the conversation, not to
 * whichever message happened to open it, so it survives that message
 * scrolling out of the virtualized log. */
export function ChatMediaProvider({ source, onDownload, disabled = false, children }: ChatMediaProviderProps) {
  const [viewer, setViewer] = useState<{ items: ChatMediaItem[]; index: number } | null>(null);
  const handle = useMemo<ChatMediaHandle>(() => ({ source, open: (items, index) => setViewer({ items, index }) }), [source]);

  return (
    <ChatMediaContext.Provider value={disabled ? null : handle}>
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
