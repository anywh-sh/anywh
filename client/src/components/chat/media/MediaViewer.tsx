import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Check, ChevronLeft, ChevronRight, Copy, Download, ImageOff, Play, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useDict } from "@/i18n";
import { mediaFileName, type ChatMediaItem } from "@/lib/media/chatMedia";
import type { ChatMediaSource } from "@/lib/media/relayMediaSource";
import { isIOS } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";
import { useMediaSrc } from "@/components/chat/media/chatMediaContext";

interface MediaViewerProps {
  items: ChatMediaItem[];
  index: number;
  source: ChatMediaSource;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Saves the file on this device — absent where the app can't (iOS). */
  onDownload?: (item: ChatMediaItem) => void;
}

/** A horizontal swipe at least this long, and mostly sideways, turns the page. */
const SWIPE_MIN_PX = 60;

/**
 * The viewer a media tile opens: one image or video at a time over a dark
 * scrim, stepping through every one of the message it came from — arrows,
 * the ← → keys, a swipe on touch, or the strip of thumbnails along the
 * bottom. An image fits the screen and a click shows it at its own pixels
 * (scrollable), which is what reading a simulator capture takes. A video
 * plays with the platform's own controls.
 *
 * A Radix dialog, so it portals to `<body>` (a fixed box inside a tab would
 * anchor to the tab's `contain`ed wrapper instead of the window) and the iOS
 * native composer hides while it's open (`useWebModalOpen`). On iOS the
 * native top bar stays over the top of the screen, so the toolbar moves to
 * the bottom there.
 */
export function MediaViewer({ items, index, source, onIndexChange, onClose, onDownload }: MediaViewerProps) {
  const dict = useDict();
  const copy = dict.chat.media.viewer;
  const current = Math.min(Math.max(index, 0), items.length - 1);
  const item = items[current];
  const many = items.length > 1;
  const toolbarAtBottom = isIOS();
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => setZoomed(false), [item.path]);

  function go(delta: number): void {
    const next = current + delta;
    if (next >= 0 && next < items.length) onIndexChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // A focused video seeks with the arrows.
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  }

  function copyPath(): void {
    navigator.clipboard.writeText(item.path).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  const caption = item.alt?.trim() || mediaFileName(item.path);
  const toolbar = (
    <div
      className={cn(
        "box-content flex h-12 shrink-0 items-center gap-0.5 px-2",
        toolbarAtBottom ? "pb-[env(safe-area-inset-bottom)]" : "pt-[env(safe-area-inset-top)]",
      )}
    >
      {many && (
        <span className="shrink-0 px-2 font-mono text-[11px] text-media-scrim-foreground/75 tabular-nums">
          {copy.counter.replace("{current}", String(current + 1)).replace("{total}", String(items.length))}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate px-2 font-mono text-[11.5px] text-media-scrim-foreground" title={item.path}>
        {caption}
      </span>
      {item.kind === "image" && (
        <Button
          variant="scrim"
          size="icon-sm"
          aria-pressed={zoomed}
          aria-label={zoomed ? copy.fitToScreen : copy.actualSize}
          onClick={() => setZoomed((value) => !value)}
        >
          {zoomed ? <ZoomOut /> : <ZoomIn />}
        </Button>
      )}
      <Button variant="scrim" size="icon-sm" aria-label={copied ? copy.pathCopied : copy.copyPath} onClick={copyPath}>
        {copied ? <Check /> : <Copy />}
      </Button>
      {onDownload && (
        <Button variant="scrim" size="icon-sm" aria-label={dict.common.download} onClick={() => onDownload(item)}>
          <Download />
        </Button>
      )}
      <DialogPrimitive.Close asChild>
        <Button variant="scrim" size="icon-sm" aria-label={dict.common.close}>
          <X />
        </Button>
      </DialogPrimitive.Close>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-media-scrim" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-media-scrim outline-none select-none"
        >
          <DialogPrimitive.Title className="sr-only">{copy.title}</DialogPrimitive.Title>
          {!toolbarAtBottom && toolbar}
          <div className={cn("relative flex min-h-0 flex-1", toolbarAtBottom && "pt-[var(--native-top-inset,calc(env(safe-area-inset-top)+64px))]")}>
            <MediaStage
              key={item.path}
              item={item}
              source={source}
              zoomed={zoomed}
              onToggleZoom={() => setZoomed((value) => !value)}
              onBackdrop={onClose}
              onSwipe={go}
            />
            {many && (
              <>
                <Button
                  variant="scrim"
                  size="icon"
                  className="absolute top-1/2 left-2 -translate-y-1/2"
                  disabled={current === 0}
                  aria-label={copy.previous}
                  onClick={() => go(-1)}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="scrim"
                  size="icon"
                  className="absolute top-1/2 right-2 -translate-y-1/2"
                  disabled={current === items.length - 1}
                  aria-label={copy.next}
                  onClick={() => go(1)}
                >
                  <ChevronRight />
                </Button>
              </>
            )}
          </div>
          {many && <Filmstrip items={items} current={current} source={source} onSelect={onIndexChange} />}
          {toolbarAtBottom && toolbar}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

interface MediaStageProps {
  item: ChatMediaItem;
  source: ChatMediaSource;
  zoomed: boolean;
  onToggleZoom: () => void;
  onBackdrop: () => void;
  onSwipe: (delta: number) => void;
}

/** The current file, fitted or at its own size. Keyed by path at the call
 * site, so moving to another file starts from a clean load state. */
function MediaStage({ item, source, zoomed, onToggleZoom, onBackdrop, onSwipe }: MediaStageProps) {
  const copy = useDict().chat.media.viewer;
  const media = useMediaSrc(source, item.path);
  const poster = useMediaSrc(source, item.kind === "video" ? item.poster : undefined);
  const [failed, setFailed] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Only the empty stage around the picture closes, never the picture.
  function onClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onBackdrop();
  }

  function onTouchStart(event: TouchEvent<HTMLDivElement>): void {
    const touch = event.touches[0];
    touchStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onTouchEnd(event: TouchEvent<HTMLDivElement>): void {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = null;
    if (!start || !touch || zoomed) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
  }

  let content;
  if (failed || media.failed) {
    content = (
      <div className="m-auto flex max-w-md flex-col items-center gap-2 px-6 text-center">
        <ImageOff className="size-8 text-media-scrim-foreground/60" />
        <p className="text-sm text-media-scrim-foreground">{copy.failed}</p>
        <p className="font-mono text-[11px] break-all text-media-scrim-foreground/60 select-text">{item.path}</p>
      </div>
    );
  } else if (!media.src) {
    content = <Spinner size="lg" tone="current" className="m-auto text-media-scrim-foreground" label={copy.title} />;
  } else if (item.kind === "video") {
    content = (
      <video
        src={media.src}
        poster={poster.src}
        controls
        autoPlay
        playsInline
        className="m-auto max-h-full max-w-full"
        onError={() => setFailed(true)}
      />
    );
  } else {
    content = (
      <img
        src={media.src}
        alt={item.alt ?? ""}
        draggable={false}
        className={zoomed ? "m-auto max-w-none cursor-zoom-out" : "m-auto max-h-full max-w-full cursor-zoom-in object-contain"}
        onClick={onToggleZoom}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 p-4", zoomed ? "overflow-auto" : "overflow-hidden")}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {content}
    </div>
  );
}

/** One thumbnail per file along the bottom, the current one outlined. */
function Filmstrip({ items, current, source, onSelect }: { items: ChatMediaItem[]; current: number; source: ChatMediaSource; onSelect: (index: number) => void }) {
  const copy = useDict().chat.media;
  const selected = useRef<HTMLButtonElement>(null);

  // Keeps the current thumbnail in view when a long strip scrolls.
  useEffect(() => {
    selected.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <div className="flex shrink-0 justify-center-safe gap-1.5 overflow-x-auto px-3 py-2">
      {items.map((item, index) => (
        <Button
          key={item.path}
          ref={index === current ? selected : undefined}
          variant="media"
          size="media"
          aria-pressed={index === current}
          aria-label={copy.open.replace("{name}", mediaFileName(item.path))}
          className="relative h-12 border-media-scrim-foreground/20 bg-media-scrim aria-pressed:border-media-scrim-foreground"
          onClick={() => onSelect(index)}
        >
          <FilmstripPicture item={item} source={source} />
        </Button>
      ))}
    </div>
  );
}

function FilmstripPicture({ item, source }: { item: ChatMediaItem; source: ChatMediaSource }) {
  const picture = useMediaSrc(source, item.kind === "video" ? item.poster : item.path);
  const [failed, setFailed] = useState(false);
  if (picture.src && !failed) {
    return (
      <>
        <img src={picture.src} alt="" draggable={false} className="block h-full w-auto" onError={() => setFailed(true)} />
        {item.kind === "video" && <Play className="pointer-events-none absolute inset-0 m-auto size-3.5 fill-current text-media-scrim-foreground" />}
      </>
    );
  }
  // A video without a poster has no picture to wait for; anything else is
  // either still on its way or gone.
  const gone = failed || picture.failed;
  return (
    <span className="flex h-full w-9 items-center justify-center text-media-scrim-foreground/60">
      {item.kind === "video" && !item.poster ? <Play className="size-3.5" /> : gone ? <ImageOff className="size-3.5" /> : <Spinner size="xs" tone="current" />}
    </span>
  );
}
