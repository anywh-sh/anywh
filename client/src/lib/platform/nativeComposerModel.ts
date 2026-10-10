import type { Dictionary } from "@/i18n/dictionary";
import { attachmentName } from "@/lib/composer/attachmentName";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import type { NativeComposerAttachment, NativeComposerPayload } from "@/lib/platform/nativeComposer";
import type { NativeShellTheme } from "@/lib/platform/nativeShell";

export interface ComposerModelInput {
  dict: Dictionary;
  theme: NativeShellTheme;
  /** A web modal is open, or there is no chat tab. */
  hidden: boolean;
  /** Relay disconnected, etc. */
  disabled: boolean;
  /** Whether the text field holds no text at all. */
  isEmpty: boolean;
  turnInFlight: boolean;
  uploading: boolean;
  pendingImages: PendingAttachment[];
  /** Text of the message being edited's banner (already localized), or `null`. */
  editBannerText: string | null;
  /** The mistyped command awaiting an answer, or `null`. */
  typo: { suggestion: string } | null;
  /** Small JPEG data URL for an attachment, or `null` when none was made (yet);
   * injected so this module never touches a canvas. */
  thumbnailFor: (attachment: PendingAttachment) => string | null;
}

/** Splits the localized question around its `{command}` placeholder, so the
 * native side can set the command in mono without parsing copy. */
function splitAroundCommand(question: string): { before: string; after: string } {
  const at = question.indexOf("{command}");
  if (at === -1) return { before: question, after: "" };
  return { before: question.slice(0, at), after: question.slice(at + "{command}".length) };
}

/**
 * Everything the native composer renders, formatted here so the native side
 * holds no logic and no copy. Typing doesn't change it: `canSend` only flips
 * when the field crosses between empty and not.
 */
export function buildComposerPayload(input: ComposerModelInput): NativeComposerPayload {
  const { dict } = input;
  const copy = dict.chat.composer;

  const attachments: NativeComposerAttachment[] = input.pendingImages.map((image) => ({
    path: image.path,
    kind: image.kind,
    thumbnail: image.previewUrl ? input.thumbnailFor(image) : null,
    name: attachmentName(image.path, copy.unnamedAttachment),
  }));

  const typo = input.typo
    ? {
        ...splitAroundCommand(copy.typo.question),
        command: input.typo.suggestion,
        useLabel: copy.typo.use,
        sendAnywayLabel: copy.typo.sendAnyway,
      }
    : null;

  return {
    hidden: input.hidden,
    placeholder: copy.placeholder,
    canSend: !input.disabled && !input.uploading && (!input.isEmpty || input.pendingImages.length > 0),
    turnInFlight: input.turnInFlight,
    attachEnabled: !input.uploading,
    uploading: input.uploading,
    attachments,
    editBanner: input.editBannerText === null ? null : { text: input.editBannerText, cancelLabel: dict.chat.message.cancelEdit },
    typo,
    strings: {
      attach: copy.attach,
      attachPhotos: copy.attachPhotos,
      attachFiles: copy.attachFiles,
      removeAttachment: copy.removeAttachment,
      uploading: copy.attachmentUploading,
      send: dict.common.send,
      stop: dict.common.stop,
      scrollToEnd: copy.scrollToEnd,
    },
    theme: input.theme,
  };
}
