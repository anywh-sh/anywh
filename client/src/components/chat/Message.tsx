import { memo, useEffect, useReducer, useRef, useState } from "react";
import { Check, Copy, Pencil, Video } from "lucide-react";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { useLongPress } from "@/hooks/useLongPress";
import { renderTextWithLinks } from "@/lib/composer/composerLinks";
import { isIOS } from "@/lib/platform/platform";
import { stripPlanChoiceMarkers } from "@/lib/relay/planChoiceMarker";
import { showNativeContextMenu } from "@/lib/platform/nativeContextMenu";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format/relativeTime";
import { useDict, useLocale } from "@/i18n";
import { cn } from "@/lib/utils";
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
        <span className="cursor-default px-1.5 font-mono text-[10.5px] text-text-faint transition-colors select-none hover:text-muted-foreground">
          {formatRelativeTime(sentAt, locale)}
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

  // Long-press (iOS) — opens the native menu
  // (`UIEditMenuInteraction`) at the touch point, with Copy/Edit. Only
  // makes sense to call on iOS; on desktop the interaction is hover + click
  // on the icons below the bubble (see `!isIOS()` in the JSX).
  const longPress = useLongPress({
    onLongPress: (point) => {
      void showNativeContextMenu(
        [
          { id: "copy", label: dict.common.copy, systemIcon: "doc.on.doc" },
          {
            id: "edit",
            label: dict.common.edit,
            systemIcon: "pencil",
            disabled: editDisabled,
            disabledReason: editDisabled ? dict.chat.message.editWithAttachment : undefined,
          },
        ],
        point,
      ).then((selectedId) => {
        if (selectedId === "copy") handleCopy();
        else if (selectedId === "edit" && !editDisabled) onStartEdit(id, text);
      });
    },
  });

  return (
    <div className="group flex flex-col items-end">
      <div
        className={cn(
          // Square and bordered, like every other surface in this design —
          // the rounded pill it used to be was the one bubble shape left
          // over from the scaffold's visual language.
          "flex max-w-[88%] flex-col gap-2 border border-border px-3.5 py-3 text-sm text-foreground",
          isEditing ? "w-[88%] bg-bg-elevated" : "bg-bubble-user",
        )}
        {...(isIOS() && !isEditing ? longPress : undefined)}
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
        // Action strip always present (fixed height reserved, only the
        // content toggles opacity) — this is what creates the requested
        // spacing before the agent's response, and avoids the bubble
        // "jumping" when hover reveals the icons (the virtualizer measures
        // the whole item's height, including this strip). Fully hidden on
        // iOS (the interaction is the long-press above, not hover — there's
        // no hover on touch).
        !isIOS() && (
          <div className="mt-1 flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <TimestampLabel sentAt={sentAt} />
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
          </div>
        )
      )}
    </div>
  );
});

interface AssistantTextProps {
  text: string;
  sentAt: number;
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
 * Timestamp/copy action strip, same interaction as `UserBubble` — minus
 * edit, which makes no sense on the assistant's own words. Hidden while
 * `streaming` is true: the response isn't final yet, and `sentAt` is only a
 * placeholder until the block actually commits (see `useMessageLog.ts`). */
export const AssistantText = memo(function AssistantText({ text, sentAt, streaming, onCopy, onOpenPath }: AssistantTextProps) {
  const dict = useDict();
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    onCopy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Long-press (iOS) — same pattern as `UserBubble`, just "Copiar" only.
  const longPress = useLongPress({
    onLongPress: (point) => {
      void showNativeContextMenu([{ id: "copy", label: dict.common.copy, systemIcon: "doc.on.doc" }], point).then((selectedId) => {
        if (selectedId === "copy") handleCopy();
      });
    },
  });

  return (
    <div className="group flex flex-col items-start" {...(isIOS() && !streaming ? longPress : undefined)}>
      <div className="prose-chat min-w-0 max-w-full text-sm text-foreground">
        <MarkdownContent text={stripPlanChoiceMarkers(text)} onOpenPath={onOpenPath} />
      </div>
      {!streaming && !isIOS() && (
        <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <TimestampLabel sentAt={sentAt} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copied ? dict.chat.message.copied : dict.chat.message.copyResponse}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      )}
    </div>
  );
});
