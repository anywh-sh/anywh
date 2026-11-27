import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, ImageOff, Video, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
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
  /** Closed, the viewer stays mounted with the last file drawn, so the
   * dialog has something to fade out. */
  open: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Saves the file on this device — absent where the app can't (iOS). */
  onDownload?: (item: ChatMediaItem) => void;
}

/** Which way the viewer last moved: the file it lands on comes in from that side. */
type Step = "next" | "prev";

/** A horizontal swipe at least this long, and mostly sideways, turns the page. */
const SWIPE_MIN_PX = 60;

/**
 * The viewer a media tile opens: a large dialog (`DialogContent
 * size="large"`) showing one image or video at a time and stepping through
 * every one of the message it came from — arrows, the ← → keys, a swipe on
 * touch, or the strip of thumbnails along the bottom. The header band names
 * the file and holds what to do with it: its own pixels (an image fits the
 * stage, and a click or the magnifier shows it 1:1, scrollable, which is
 * what reading a simulator capture takes), copy its path, download it. A
 * video plays with the platform's own controls.
 *
 * A Radix dialog, so it portals to `<body>` (a fixed box inside a tab would
 * anchor to the tab's `contain`ed wrapper instead of the window) and the iOS
 * native composer hides while it's open (`useWebModalOpen`); the large size
 * keeps the frame clear of the native top bar there.
 */
export function MediaViewer({ items, index, source, open, onIndexChange, onClose, onDownload }: MediaViewerProps) {
  const dict = useDict();
  const copy = dict.chat.media.viewer;
  const current = Math.min(Math.max(index, 0), items.length - 1);
  const item = items[current];
  const many = items.length > 1;
  // On iOS a swipe or the strip turns the page, and the arrows would only
  // take width from the picture.
  const arrows = many && !isIOS();
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  // The file the stage couldn't load: nothing to zoom into or download.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const failed = failedPath === item.path;
  const markFailed = useCallback(() => setFailedPath(item.path), [item.path]);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => setZoomed(false), [item.path]);

  function select(next: number): void {
    if (next < 0 || next >= items.length || next === current) return;
    setStep(next > current ? "next" : "prev");
    onIndexChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // A focused video seeks with the arrows.
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      select(current - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      select(current + 1);
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

  const name = mediaFileName(item.path);
  const caption = item.alt?.trim() || name;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        ref={contentRef}
        size="large"
        aria-describedby={undefined}
        // The frame itself takes focus, not its first button: ← → work at
        // once, and no tooltip pops up over the picture as it opens.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onKeyDown={onKeyDown}
        className="select-none"
      >
        <DialogHeader
          actions={
            <>
              {many && (
                <span className="px-1.5 font-mono text-[11px] text-text-faint tabular-nums">
                  {copy.counter.replace("{current}", String(current + 1)).replace("{total}", String(items.length))}
                </span>
              )}
              {item.kind === "image" && !failed && (
                <HeaderAction label={zoomed ? copy.fitToScreen : copy.actualSize} pressed={zoomed} onClick={() => setZoomed((value) => !value)} onEscape={onClose}>
                  {zoomed ? <ZoomOut className="size-3.5" /> : <ZoomIn className="size-3.5" />}
                </HeaderAction>
              )}
              <HeaderAction label={copied ? copy.pathCopied : copy.copyPath} onClick={copyPath} onEscape={onClose}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </HeaderAction>
              {onDownload && !failed && (
                <HeaderAction label={dict.common.download} onClick={() => onDownload(item)} onEscape={onClose}>
                  <Download className="size-3.5" />
                </HeaderAction>
              )}
            </>
          }
        >
          <div className="flex min-w-0 items-baseline gap-2.5">
            <DialogTitle className="min-w-0">{caption}</DialogTitle>
            {caption !== name && (
              <span className="hidden min-w-0 shrink-[2] truncate font-mono text-[11px] text-text-faint sm:block" title={item.path}>
                {name}
              </span>
            )}
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 bg-background">
          {arrows && (
            <StepButton label={copy.previous} shortcut="←" disabled={current === 0} onClick={() => select(current - 1)} onEscape={onClose}>
              <ChevronLeft />
            </StepButton>
          )}
          <MediaStage
            key={item.path}
            item={item}
            source={source}
            step={step}
            zoomed={zoomed}
            onToggleZoom={() => setZoomed((value) => !value)}
            onSwipe={(delta) => select(current + delta)}
            onFailed={markFailed}
          />
          {arrows && (
            <StepButton label={copy.next} shortcut="→" disabled={current === items.length - 1} onClick={() => select(current + 1)} onEscape={onClose}>
              <ChevronRight />
            </StepButton>
          )}
        </div>
        {many && <Filmstrip items={items} current={current} source={source} onSelect={select} />}
      </DialogContent>
    </Dialog>
  );
}

interface ControlProps {
  label: string;
  onClick: () => void;
  /** Closes the viewer. An open tooltip is the topmost layer, and Radix
   * hands Escape to that layer alone: without this, the Escape that should
   * close the viewer only hides the tooltip of the button under the pointer. */
  onEscape: () => void;
  children: ReactNode;
}

/** A control in the header band, named by its tooltip as well as its label. */
function HeaderAction({ label, pressed, onClick, onEscape, children }: ControlProps & { pressed?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" onEscapeKeyDown={onEscape}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Previous or next, in a gutter of its own beside the stage: never over
 * the picture, so it needs no backing to stay legible on a bright one. */
function StepButton({ label, shortcut, disabled, onClick, onEscape, children }: ControlProps & { shortcut: string; disabled: boolean }) {
  return (
    <div className="flex w-14 shrink-0 items-center justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label={label} disabled={disabled} onClick={onClick}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" onEscapeKeyDown={onEscape}>
          {label}
          <TooltipShortcut>{shortcut}</TooltipShortcut>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface MediaStageProps {
  item: ChatMediaItem;
  source: ChatMediaSource;
  /** How the viewer got here, if by moving: the file slides in from that side. */
  step: Step | null;
  zoomed: boolean;
  onToggleZoom: () => void;
  onSwipe: (delta: number) => void;
  onFailed: () => void;
}

/** The current file, fitted or at its own size. Keyed by path at the call
 * site, so moving to another file starts from a clean load state (and plays
 * the step in). */
function MediaStage({ item, source, step, zoomed, onToggleZoom, onSwipe, onFailed }: MediaStageProps) {
  const dict = useDict();
  const copy = dict.chat.media.viewer;
  const media = useMediaSrc(source, item.path);
  const poster = useMediaSrc(source, item.kind === "video" ? item.poster : undefined);
  const [failed, setFailed] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const gone = failed || media.failed;

  useEffect(() => {
    if (gone) onFailed();
  }, [gone, onFailed]);

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
  if (gone) {
    content = (
      <div className="m-auto flex max-w-md flex-col items-center gap-2 px-6 text-center">
        <ImageOff className="size-8 text-text-faint" />
        <p className="text-sm text-muted-foreground">{copy.failed}</p>
        <p className="font-mono text-[11px] break-all text-text-faint select-text">{item.path}</p>
      </div>
    );
  } else if (!media.src) {
    content = <Spinner size="lg" className="m-auto" label={dict.common.loading} />;
  } else if (item.kind === "video") {
    content = (
      <video
        src={media.src}
        poster={poster.src}
        controls
        autoPlay
        playsInline
        className="m-auto max-h-full max-w-full border border-border"
        onError={() => setFailed(true)}
      />
    );
  } else {
    content = (
      <img
        src={media.src}
        alt={item.alt ?? ""}
        draggable={false}
        // The tiles' hairline: on a light theme a light capture would
        // otherwise have no edge against the stage.
        className={cn("m-auto border border-border", zoomed ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
        onClick={onToggleZoom}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      data-media-step={step ?? undefined}
      className={cn("flex min-h-0 min-w-0 flex-1 p-4", zoomed ? "overflow-auto" : "overflow-hidden")}
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
    <div className="flex shrink-0 justify-center-safe gap-1.5 overflow-x-auto border-t border-border bg-bg-chrome px-3 py-2.5">
      {items.map((item, index) => (
        <Button
          key={item.path}
          ref={index === current ? selected : undefined}
          variant="media"
          size="media"
          aria-pressed={index === current}
          aria-label={copy.open.replace("{name}", mediaFileName(item.path))}
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
        <img src={picture.src} alt="" draggable={false} className="block h-12 w-auto" onError={() => setFailed(true)} />
        {item.kind === "video" && (
          // The composer's badge for an attached video, in the corner: a
          // phone capture's thumbnail is barely wider than a centred one.
          <span className="pointer-events-none absolute bottom-0 left-0 flex size-4 items-center justify-center bg-media-scrim text-media-scrim-foreground">
            <Video className="size-2.5" />
          </span>
        )}
      </>
    );
  }
  // A video without a poster has no picture to wait for; anything else is
  // either still on its way or gone.
  const gone = failed || picture.failed;
  return (
    <span className="flex h-12 w-9 items-center justify-center text-text-faint">
      {item.kind === "video" && !item.poster ? <Video className="size-3.5" /> : gone ? <ImageOff className="size-3.5" /> : <Spinner size="xs" />}
    </span>
  );
}
