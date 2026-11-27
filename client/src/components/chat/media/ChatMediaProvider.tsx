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

interface ViewerState {
  items: ChatMediaItem[];
  index: number;
  open: boolean;
  /** Counts the openings: each one is a fresh viewer (no zoom or copied
   * check carried over), while a close keeps the same one to fade out. */
  opening: number;
}

/** Gives the tiles of a conversation their bytes and the one viewer they
 * open. One per chat panel: the viewer belongs to the conversation, not to
 * whichever message happened to open it, so it survives that message
 * scrolling out of the virtualized log. */
export function ChatMediaProvider({ source, onDownload, disabled = false, children }: ChatMediaProviderProps) {
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const handle = useMemo<ChatMediaHandle>(
    () => ({ source, open: (items, index) => setViewer((last) => ({ items, index, open: true, opening: (last?.opening ?? 0) + 1 })) }),
    [source],
  );

  return (
    <ChatMediaContext.Provider value={disabled ? null : handle}>
      {children}
      {viewer && (
        <MediaViewer
          key={viewer.opening}
          items={viewer.items}
          index={viewer.index}
          source={source}
          open={viewer.open}
          onIndexChange={(index) => setViewer((last) => (last ? { ...last, index } : last))}
          onClose={() => setViewer((last) => (last ? { ...last, open: false } : last))}
          onDownload={onDownload}
        />
      )}
    </ChatMediaContext.Provider>
  );
}
