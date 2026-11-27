import { useMemo } from "react";
import { mentionedMedia } from "@/lib/media/mentionedMedia";
import { useChatMedia } from "@/components/chat/media/chatMediaContext";
import { MediaTile } from "@/components/chat/media/MediaTile";

/**
 * Previews of the images and videos a finished reply names without
 * embedding them (`mentionedMedia`), in a row under it: what the agent made
 * or captured is seen even when all it said is where it put it. A name that
 * isn't a file the relay can serve drops out quietly, and the container
 * hides itself (`empty:hidden`) once every tile has. The tiles carry the same
 * paths as the reply's own path links, so the viewer walks each file once.
 */
export function MentionedMedia({ text }: { text: string }) {
  const media = useChatMedia();
  const items = useMemo(() => mentionedMedia(text), [text]);
  if (!media || items.length === 0) return null;
  return (
    <div data-mentioned-media="" className="mt-3 flex flex-wrap items-start gap-1.5 empty:hidden">
      {items.map((item) => (
        <MediaTile key={item.path} item={item} layout="grid" quiet />
      ))}
    </div>
  );
}
