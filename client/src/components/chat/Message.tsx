import { memo, useEffect, useReducer, useRef, useState } from "react";
import { Check, Copy, Pencil, Video } from "lucide-react";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { useLongPress } from "@/hooks/useLongPress";
import { renderTextWithLinks } from "@/lib/composer/composerLinks";
import { isIOS } from "@/lib/platform/platform";
import { stripPlanChoiceMarkers } from "@/lib/relay/planChoiceMarker";
import { showNativeContextMenu } from "@/lib/platform/nativeContextMenu";
import { bubbleMenu } from "@/lib/platform/bubbleMenu";
import { formatAbsoluteTime, formatClockTime } from "@/lib/format/relativeTime";
import { useDict, useLocale } from "@/i18n";
import { cn, formatDurationLong } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

interface UserBubbleProps {
  id: string;
  text: string;
  images?: PendingAttachment[];
  sentAt: number;
  isEditing: boolean;
  onStartEdit: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, text: string) => void;
  onCopy: (text: string) => void;
}

/** Relative timestamp ("3 min ago") with a tooltip revealing the exact time
 * — its own component just to isolate the 60s tick (re-render) from the
 * rest of `UserBubble`, which doesn't need to re-render as time passes. */
function TimestampLabel({ sentAt }: { sentAt: number }) {
  const { locale } = useLocale();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const interval = window.setInterval(tick, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default pl-1.5 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint transition-colors select-none hover:text-muted-foreground">
          {formatClockTime(sentAt, locale)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{formatAbsoluteTime(sentAt, locale)}</TooltipContent>
    </Tooltip>
  );
}

/** Preview appears inside the sent message, not just as a pre-send chip.
 *
 * Memoized (same as `AssistantText` below): without this, every streaming
 * token re-renders the whole `MessageLog`, and without `memo` React
 * re-executes ALL already-committed messages again (including markdown
 * parsing + syntax highlighting for old ones), not just the one being
 * written now — this is the root cause of slowness during active
 * generation. The callbacks (`onStartEdit` etc.) need stable identity from
 * the caller (refs, not fresh closures on every `ChatPanel` render),
 * otherwise this `memo` holds nothing back — see `ChatPanel.tsx`. */
export const UserBubble = memo(function UserBubble({
  id,
  text,
  images,
  sentAt,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onCopy,
}: UserBubbleProps) {
  const dict = useDict();
  const editDisabled = Boolean(images && images.length > 0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${String(el.scrollHeight)}px`;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isEditing]);

  function autoResize(): void {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${String(el.scrollHeight)}px`;
  }

  function handleSave(): void {
    const value = textareaRef.current?.value.trim() ?? "";
    if (value) onSaveEdit(id, value);
  }

  function handleCopy(): void {
    onCopy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Long-press (iOS) — the system's own lifted-bubble menu with Copy/Edit.
  // It runs natively, so the bubble arms it on `touchstart` with its rectangle
  // and items (see `bubbleMenu`); the pick comes back through `onSelect`. On
  // desktop the interaction is hover + click on the icons below the bubble
  // (see `!isIOS()` in the JSX).
  function armNativeMenu(event: React.TouchEvent<HTMLDivElement>): void {
    const box = event.currentTarget.getBoundingClientRect();
    bubbleMenu.arm({
      id,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      items: [
        { id: "copy", label: dict.common.copy, systemIcon: "doc.on.doc" },
        {
          id: "edit",
          label: dict.common.edit,
          systemIcon: "pencil",
          disabled: editDisabled,
          disabledReason: editDisabled ? dict.chat.message.editWithAttachment : undefined,
        },
      ],
      onSelect: (itemId) => {
        if (itemId === "copy") handleCopy();
        else if (itemId === "edit" && !editDisabled) onStartEdit(id, text);
      },
    });
  }

  return (
    <div className="group flex flex-col items-end">
      <div
        className={cn(
          // Square and borderless: the fill alone sets it apart from the
          // plane, like every other surface in this design.
          "flex max-w-[88%] flex-col gap-2 px-3.5 py-2.5 text-[15px] leading-[1.55] text-foreground",
          isEditing ? "w-[88%] bg-bg-elevated" : "bg-bubble-user",
          // The log is text-selectable, so on iOS a held finger starts the
          // system's word selection before the long-press timer fires and
          // the native Copy/Edit menu never opens. The menu has Copy.
          isIOS() && !isEditing && "select-none [-webkit-touch-callout:none]",
        )}
        {...(isIOS() && !isEditing ? { onTouchStart: armNativeMenu, "data-native-menu": "" } : undefined)}
      >
        {isEditing ? (
          <textarea
            ref={textareaRef}
            defaultValue={text}
            onInput={autoResize}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSave();
              } else if (event.key === "Escape") {
                onCancelEdit();
              }
            }}
            rows={1}
            className="w-full resize-none bg-transparent text-sm text-foreground outline-none"
          />
        ) : (
          <>
            {images && images.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {images.map((image) => (
                  <div key={image.path} className="relative">
                    {image.previewUrl ? (
                      <img src={image.previewUrl} alt="" className="max-h-48 max-w-full object-cover" />
                    ) : (
                      <div className="flex size-24 items-center justify-center bg-border text-muted-foreground">
                        <Video className="size-6" />
                      </div>
                    )}
                    {image.kind === "video" && (
                      <div className="pointer-events-none absolute bottom-1 left-1 flex size-5 items-center justify-center rounded-full bg-media-scrim text-media-scrim-foreground">
                        <Video className="size-3" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {text && <p className="whitespace-pre-wrap">{renderTextWithLinks(text)}</p>}
          </>
        )}
      </div>

      {isEditing ? (
        <div className="mt-1 flex h-7 items-center justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>
            {dict.common.cancel}
          </Button>
          <Button type="button" size="sm" onClick={handleSave}>
            {dict.common.save}
          </Button>
        </div>
      ) : (
        // Meta strip always present (fixed height reserved) — this is what
        // creates the spacing before the agent's response, and avoids the
        // bubble "jumping" when hover reveals the icons (the virtualizer
        // measures the whole item's height, including this strip). The time
        // is always visible; copy/edit appear on hover. Fully hidden on iOS
        // (the interaction is the long-press above, not hover — there's no
        // hover on touch).
        !isIOS() && (
          <div className="mt-1 flex h-6 items-center justify-end gap-0.5">
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleCopy}
              aria-label={copied ? dict.chat.message.copied : dict.chat.message.copy}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
            {editDisabled ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* `span` wrapper: a `disabled` button receives no pointer
                   * events at all, so the Tooltip would never open if the
                   * trigger were the button itself. */}
                  <span>
                    <Button type="button" variant="ghost" size="icon-xs" disabled aria-label={dict.chat.message.editUnavailable}>
                      <Pencil />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{dict.chat.message.editWithAttachment}</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onStartEdit(id, text)}
                aria-label={dict.chat.message.edit}
              >
                <Pencil />
              </Button>
            )}
            </span>
            <TimestampLabel sentAt={sentAt} />
          </div>
        )
      )}
    </div>
  );
});

interface AssistantTextProps {
  text: string;
  streaming: boolean;
  onCopy: (text: string) => void;
  /** Opens a path mentioned in inline code in the work dir file panel —
   * desktop only, `undefined` on compact/iOS where that panel doesn't exist
   * (see `MarkdownContent`'s `code` override, which falls back to plain
   * code when this is absent). */
  onOpenPath?: (path: string) => void;
}

/** Memoized — see comment on `UserBubble`. `MarkdownContent` re-parses
 * markdown and re-runs syntax highlighting in full on every render; without
 * `memo`, this would run again for every old message on every new token
 * streamed in ANY message in the conversation.
 *
 * No action strip of its own: a reply is often several text blocks with
 * tool calls between them, and the time/copy actions belong to the turn as a
 * whole (`TurnFooter`). Long-press on iOS still copies the block. */
export const AssistantText = memo(function AssistantText({ text, streaming, onCopy, onOpenPath }: AssistantTextProps) {
  const dict = useDict();

  const longPress = useLongPress({
    onLongPress: (point) => {
      void showNativeContextMenu([{ id: "copy", label: dict.common.copy, systemIcon: "doc.on.doc" }], point).then((selectedId) => {
        if (selectedId === "copy") onCopy(text);
      });
    },
  });

  return (
    <div className="flex flex-col items-start" {...(isIOS() && !streaming ? longPress : undefined)}>
      <div className="prose-chat min-w-0 max-w-full text-sm text-foreground">
        <MarkdownContent text={stripPlanChoiceMarkers(text)} onOpenPath={onOpenPath} />
      </div>
    </div>
  );
});

interface TurnFooterProps {
  sentAt: number;
  durationMs?: number;
  /** Everything the agent said in the turn, what "copy" copies. */
  text: string;
  onCopy: (text: string) => void;
}

/** Closes a turn: when it finished, how long the agent worked, and a copy
 * button for the whole reply — the button appears on hover on desktop; on
 * iOS the reply is copied by long-press instead. */
export const TurnFooter = memo(function TurnFooter({ sentAt, durationMs, text, onCopy }: TurnFooterProps) {
  const dict = useDict();
  const [copied, setCopied] = useState(false);
  const worked = durationMs !== undefined ? dict.chat.activity.workedFor.replace("{time}", formatDurationLong(Math.round(durationMs / 1000))) : undefined;

  return (
    <div className="mt-1 flex h-7 items-center gap-0.5">
      {!isIOS() && text !== "" && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            onCopy(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          aria-label={copied ? dict.chat.message.copied : dict.chat.message.copyResponse}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      )}
      {worked && <span className="px-1.5 font-mono text-[length:calc(11.5px*var(--chrome-scale))] text-text-faint select-none">{worked} ·</span>}
      <TimestampLabel sentAt={sentAt} />
    </div>
  );
});

interface AssistantHeaderProps {
  agentLabel: string;
  modelLabel?: string;
  /** When the turn began, for the meta line. */
  at: number;
}

/** Opens an agent turn: who answers and with which model, and when. Plain
 * monochrome dot instead of the vendor mark — the brand colour is not part of
 * the palette, and the name already says which agent it is. */
export const AssistantHeader = memo(function AssistantHeader({ agentLabel, modelLabel, at }: AssistantHeaderProps) {
  const { locale } = useLocale();
  return (
    <div className="mb-3 flex items-center gap-[9px]">
      <span className="flex size-[calc(14px*var(--chrome-scale))] shrink-0 items-center justify-center rounded-full border border-border" aria-hidden>
        <span className="size-1 rounded-full bg-muted-foreground" />
      </span>
      <span className="text-[length:calc(13px*var(--chrome-scale))] font-medium text-foreground">{agentLabel}</span>
      <span className="font-mono text-[length:calc(11.5px*var(--chrome-scale))] text-text-faint">
        {modelLabel ? `${modelLabel} · ` : ""}
        {formatClockTime(at, locale)}
      </span>
    </div>
  );
});
