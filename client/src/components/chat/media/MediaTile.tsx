import { createContext, memo, useContext, useState, type CSSProperties, type MouseEvent } from "react";
import { ImageOff, Play, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDict } from "@/i18n";
import { mediaFileName, type ChatMediaItem } from "@/lib/media/chatMedia";
import { cn } from "@/lib/utils";
import { mediaAround, mediaDataAttributes, useChatMedia, useMediaSrc } from "@/components/chat/media/chatMediaContext";

/** How big a tile draws its picture: alone (`single`), one of several in a
 * gallery (`grid`), or inside a line of text or a table cell (`inline`). */
export type MediaTileLayout = "single" | "grid" | "inline";

/** Set by `MediaGallery` for the tiles inside it; a tile outside any
 * gallery is `inline`. */
export const MediaLayoutContext = createContext<MediaTileLayout>("inline");

/** A tile's height per layout, in px — fixed while the picture is on its way
 * so the message keeps its height, and the cap once it has landed. */
const HEIGHT: Record<MediaTileLayout, number> = { single: 288, grid: 160, inline: 96 };

const PICTURE_CLASS: Record<MediaTileLayout, string> = {
  single: "max-h-72",
  grid: "h-40",
  inline: "max-h-24",
};

/** A picture's proportion, kept across remounts (the log is virtualized, so
 * scrolling away and back mounts a tile again): its placeholder then takes
 * the real width at once. Before the first load, a phone screen's. */
const ratios = new Map<string, number>();
const DEFAULT_RATIO = 0.6;

function placeholderStyle(path: string, layout: MediaTileLayout): CSSProperties {
  const height = HEIGHT[layout];
  return { height, width: Math.round(height * (ratios.get(path) ?? DEFAULT_RATIO)) };
}

interface MediaTileProps {
  item: ChatMediaItem;
  /** Overrides the layout of the gallery around it (a sent attachment). */
  layout?: MediaTileLayout;
  /** A picture already on this device — the sender's own preview of what
   * they just attached — shown instead of fetching one. */
  previewSrc?: string;
}

/**
 * One image or video in a message, opening the viewer on click with every
 * other one of the same message (`mediaAround`). A video shows its first
 * frame where it can — its poster (a sent video's extracted frame), or the
 * video itself paused at the start on a direct connection — and an icon
 * otherwise, since over a tailnet the only way to a frame is the whole file.
 * A file the relay can't serve (moved, deleted, a temp dir wiped) becomes a
 * one-line chip with its name, which still opens the viewer to say why.
 */
export const MediaTile = memo(function MediaTile({ item, layout: layoutOverride, previewSrc }: MediaTileProps) {
  const media = useChatMedia();
  const copy = useDict().chat.media;
  const galleryLayout = useContext(MediaLayoutContext);
  const layout = layoutOverride ?? galleryLayout;
  const fetched = useMediaSrc(media?.source, previewSrc ? undefined : item.kind === "video" ? item.poster : item.path);
  const picture = previewSrc ? { src: previewSrc, failed: false } : fetched;
  // A video with nothing but itself to show, on a connection that has a
  // plain URL for it.
  const frameUrl = item.kind === "video" && !item.poster && !previewSrc ? media?.source.url(item.path) : undefined;
  const iconOnly = !picture.src && !frameUrl && (!media || (item.kind === "video" && !item.poster));
  const [state, setState] = useState<"loading" | "ready" | "failed">(iconOnly ? "ready" : "loading");
  const failed = state === "failed" || picture.failed;
  const name = mediaFileName(item.path);

  function open(event: MouseEvent<HTMLButtonElement>): void {
    if (!media) return;
    const { items, index } = mediaAround(event.currentTarget);
    media.open(items, index);
  }

  function loaded(width: number, height: number): void {
    if (width > 0 && height > 0) ratios.set(item.path, width / height);
    setState("ready");
  }

  if (failed) {
    return (
      <Button
        variant="media"
        size="sm"
        className="max-w-full justify-start gap-2 px-2.5 text-[11px] font-normal"
        onClick={open}
        aria-label={copy.open.replace("{name}", name)}
        {...mediaDataAttributes(item)}
      >
        <ImageOff className="size-3.5 text-text-faint" />
        <span className="min-w-0 truncate text-foreground">{name}</span>
        <span className="shrink-0 text-text-faint">{copy.unavailable}</span>
      </Button>
    );
  }

  const pictureClass = cn("block w-auto max-w-full", PICTURE_CLASS[layout], state !== "ready" && "invisible absolute");

  return (
    <Button
      variant="media"
      size="media"
      className="max-w-full"
      onClick={open}
      aria-label={copy.open.replace("{name}", name)}
      {...mediaDataAttributes(item)}
    >
      {picture.src ? (
        <img
          src={picture.src}
          alt={item.alt ?? ""}
          draggable={false}
          className={pictureClass}
          onLoad={(event) => loaded(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          onError={() => setState("failed")}
        />
      ) : frameUrl ? (
        // `#t=0.1`: without a start time WebKit paints nothing until play.
        <video
          src={`${frameUrl}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          disablePictureInPicture
          tabIndex={-1}
          className={pictureClass}
          onLoadedData={(event) => loaded(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          onError={() => setState("failed")}
        />
      ) : iconOnly ? (
        <span className="flex aspect-video items-center justify-center text-text-faint" style={{ height: HEIGHT[layout] }}>
          {item.kind === "video" ? <Video className="size-6" /> : <ImageOff className="size-6" />}
        </span>
      ) : null}
      {state === "loading" && <Skeleton className="block" style={placeholderStyle(item.path, layout)} />}
      {item.kind === "video" && state === "ready" && (
        <span
          aria-label={copy.video}
          className="pointer-events-none absolute inset-0 m-auto flex size-9 items-center justify-center rounded-full bg-media-scrim text-media-scrim-foreground"
        >
          <Play className="size-4 fill-current" />
        </span>
      )}
    </Button>
  );
});
