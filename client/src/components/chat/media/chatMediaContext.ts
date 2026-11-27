import { createContext, useContext, useEffect, useState } from "react";
import { chatMediaKind, type ChatMediaItem } from "@/lib/media/chatMedia";
import type { ChatMediaSource } from "@/lib/media/relayMediaSource";

/** What a tile needs from the conversation around it: where bytes come
 * from, and the viewer to open. Absent outside a conversation (the file
 * panel's Markdown preview), where an image stays a plain caption. */
export interface ChatMediaHandle {
  source: ChatMediaSource;
  open(items: ChatMediaItem[], index: number): void;
}

export const ChatMediaContext = createContext<ChatMediaHandle | null>(null);

export function useChatMedia(): ChatMediaHandle | null {
  return useContext(ChatMediaContext);
}

/** How big a tile draws its picture: alone (`single`), one of several in a
 * gallery (`grid`), or inside a line of text or a table cell (`inline`). */
export type MediaTileLayout = "single" | "grid" | "inline";

/** Set by `MediaGallery` for the tiles inside it; a tile outside any
 * gallery is `inline`. */
export const MediaLayoutContext = createContext<MediaTileLayout>("inline");

/** Whether a path written as inline code opens the viewer here: it names
 * an image or video, and there is a conversation to open it in. */
export function useOpensAsMedia(path: string): boolean {
  return useChatMedia() !== null && chatMediaKind(path) !== undefined;
}

/**
 * `src` for `path`: the direct URL right away, or the fetched object URL once
 * it arrives (`ChatMediaSource`). `failed` only covers the fetch — a direct
 * URL that doesn't load is the element's own `onError` to notice.
 */
export function useMediaSrc(source: ChatMediaSource | undefined, path: string | undefined): { src?: string; failed: boolean } {
  const direct = path === undefined ? undefined : source?.url(path);
  const [loaded, setLoaded] = useState<{ path: string; src?: string; failed: boolean } | null>(null);

  useEffect(() => {
    if (!source || path === undefined || direct !== undefined) return;
    let cancelled = false;
    source.load(path).then(
      (src) => {
        if (!cancelled) setLoaded({ path, src, failed: false });
      },
      () => {
        if (!cancelled) setLoaded({ path, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, path, direct]);

  if (direct !== undefined) return { src: direct, failed: false };
  return loaded !== null && loaded.path === path ? loaded : { failed: false };
}

/** The data attributes a clickable media element carries, which is how the
 * viewer finds every other one in the same message (`mediaAround`). */
export function mediaDataAttributes(item: ChatMediaItem): Record<string, string | undefined> {
  return {
    "data-chat-media-path": item.path,
    "data-chat-media-kind": item.kind,
    "data-chat-media-alt": item.alt,
    "data-chat-media-poster": item.poster,
  };
}

function itemOf(element: HTMLElement): ChatMediaItem | undefined {
  const path = element.dataset.chatMediaPath;
  if (!path) return undefined;
  const kind = element.dataset.chatMediaKind === "video" || element.dataset.chatMediaKind === "image" ? element.dataset.chatMediaKind : chatMediaKind(path);
  if (!kind) return undefined;
  return { path, kind, alt: element.dataset.chatMediaAlt || undefined, poster: element.dataset.chatMediaPoster || undefined };
}

/**
 * Every image and video of the message `element` sits in, in reading
 * order, and where `element` falls among them — so the viewer opened from
 * one tile walks the whole reply (a gallery, a caption, then another image)
 * and not just the tile's own row. Read from the DOM at the click, because
 * a message is rendered by a Markdown pass whose elements know nothing of
 * each other; the message root marks the boundary with `data-media-scope`.
 * A file mentioned twice (embedded, and as a path) counts once.
 */
export function mediaAround(element: HTMLElement): { items: ChatMediaItem[]; index: number } {
  const scope = element.closest<HTMLElement>("[data-media-scope]");
  const elements = scope ? Array.from(scope.querySelectorAll<HTMLElement>("[data-chat-media-path]")) : [element];
  const items: ChatMediaItem[] = [];
  const indexByPath = new Map<string, number>();
  for (const candidate of elements) {
    const item = itemOf(candidate);
    if (!item || indexByPath.has(item.path)) continue;
    indexByPath.set(item.path, items.length);
    items.push(item);
  }
  const own = itemOf(element);
  if (!own) return { items, index: 0 };
  if (!indexByPath.has(own.path)) return { items: [own], index: 0 };
  return { items, index: indexByPath.get(own.path) ?? 0 };
}
