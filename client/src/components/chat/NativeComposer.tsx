import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useDict } from "@/i18n";
import { formatElapsed } from "@/components/chat/activity/Elapsed";
import type { ComposerHandle, ComposerProps } from "@/components/chat/Composer";
import { useDraftSync } from "@/hooks/composer/useDraftSync";
import { toHex, useThemeVersion } from "@/hooks/platform/useNativeShell";
import { useWebModalOpen } from "@/hooks/platform/useWebModalOpen";
import type { PendingAttachment } from "@/hooks/media/useImageUpload";
import { decideSubmit } from "@/lib/composer/composerSubmit";
import { thumbnailDataUrl } from "@/lib/composer/thumbnail";
import {
  blurNativeComposer,
  focusNativeComposer,
  listenNativeComposer,
  readNativeAttachment,
  setNativeComposer,
  setNativeComposerElapsed,
  setNativeComposerText,
  setNativeScrollToEnd,
  type NativeComposerPayload,
} from "@/lib/platform/nativeComposer";
import { buildComposerPayload } from "@/lib/platform/nativeComposerModel";
import { createNativeComposerOwner } from "@/lib/platform/nativeComposerOwner";
import { buildShellTheme } from "@/lib/platform/nativeShellModel";

const THUMBNAIL_SIDE = 112;

/** Last payload sent, so the owner can hide the composer by resending it. */
let lastPayload: NativeComposerPayload | null = null;

const owner = createNativeComposerOwner(() => {
  if (lastPayload) void setNativeComposer({ ...lastPayload, hidden: true }).catch(() => {});
  void setNativeScrollToEnd(false, 0).catch(() => {});
});

/** `Composer`'s handle plus what only the native field offers (the web editor
 * has no keyboard to dismiss from the outside). */
export type NativeComposerHandle = ComposerHandle & {
  /** Closes the keyboard if the native field has focus. */
  blurIfFocused?: () => void;
};

export interface NativeComposerProps extends Pick<
  ComposerProps,
  "onSend" | "disabled" | "turnInFlight" | "turnStartedAt" | "onStop" | "pendingImages" | "uploadingImage" | "onAddFiles" | "onRemoveImage" | "modelCatalog" | "onChangeDraft"
> {
  /** Localized warning shown above the field while a message is being edited, else `null`. */
  editBannerText: string | null;
  onCancelEdit: () => void;
  /** The arrow's tap. */
  onScrollToEnd: () => void;
  scrollToEndVisible: boolean;
  /** Height of the web stack floating above the composer, so the arrow clears it. */
  accessoryHeight: number;
}

/**
 * The iOS composer: headless, the field itself is native (see the
 * `native-chrome` plugin). It keeps the same contract as `Composer` —
 * `onSend`, attachments, `ComposerHandle` — so `ChatPanel` only swaps one for
 * the other. This side decides (what a submit means, the typo check, the
 * draft, the upload); native only draws and captures input.
 */
export const NativeComposer = forwardRef<NativeComposerHandle, NativeComposerProps>(function NativeComposer(props, ref) {
  const { pendingImages, uploadingImage, turnInFlight, turnStartedAt, disabled, editBannerText } = props;
  const id = useId();
  const dict = useDict();
  const themeVersion = useThemeVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const theme = useMemo(() => buildShellTheme(toHex), [themeVersion]);
  const modalOpen = useWebModalOpen();

  // Latest props for the native callbacks, which outlive any one render.
  const propsRef = useRef(props);
  propsRef.current = props;

  const textRef = useRef("");
  const focusedRef = useRef(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [typo, setTypo] = useState<{ text: string; suggestion: string } | null>(null);
  const typoRef = useRef(typo);
  typoRef.current = typo;
  const draft = useDraftSync(props.onChangeDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The native side can't read `blob:` previews, so each one travels as a
  // small data URL, made once.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const image of pendingImages) {
      if (!image.previewUrl || thumbnails[image.path] !== undefined) continue;
      void thumbnailDataUrl(image.previewUrl, THUMBNAIL_SIDE).then((url) => {
        if (url) setThumbnails((current) => ({ ...current, [image.path]: url }));
      });
    }
  }, [pendingImages, thumbnails]);
  const thumbnailFor = useCallback((attachment: PendingAttachment) => thumbnails[attachment.path] ?? null, [thumbnails]);

  const payload = useMemo(
    () =>
      buildComposerPayload({
        dict,
        theme,
        hidden: modalOpen,
        disabled: disabled ?? false,
        isEmpty,
        turnInFlight,
        uploading: uploadingImage,
        pendingImages,
        editBannerText,
        typo,
        thumbnailFor,
      }),
    [dict, theme, modalOpen, disabled, isEmpty, turnInFlight, uploadingImage, pendingImages, editBannerText, typo, thumbnailFor],
  );
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(payload);
    lastPayload = payload;
    if (serialized === lastSentRef.current) return;
    lastSentRef.current = serialized;
    void setNativeComposer(payload).catch(() => {});
  }, [payload]);

  // Single owner of the native composer: hides it once the last panel is gone.
  // There is only one native field, so it still holds whatever the previous
  // conversation left in it: clear it on taking over (a saved draft is applied
  // by `ChatPanel` right after), and save this conversation's text on the way out.
  useEffect(() => {
    owner.claim(id);
    void setNativeComposerText("").catch(() => {});
    return () => {
      draftRef.current.flush(textRef.current.trim());
      owner.release(id);
    };
  }, [id]);

  // The turn clock, formatted here so native holds no formatting.
  useEffect(() => {
    if (!turnInFlight || turnStartedAt == null) return;
    const tick = (): void => void setNativeComposerElapsed(formatElapsed(Date.now() - turnStartedAt)).catch(() => {});
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      void setNativeComposerElapsed(null).catch(() => {});
    };
  }, [turnInFlight, turnStartedAt]);

  const { scrollToEndVisible, accessoryHeight } = props;
  useEffect(() => {
    void setNativeScrollToEnd(scrollToEndVisible, accessoryHeight).catch(() => {});
  }, [scrollToEndVisible, accessoryHeight]);

  /** Programmatic text change: native applies it without echoing it back. */
  const putText = useCallback((text: string) => {
    textRef.current = text;
    setIsEmpty(text.length === 0);
    void setNativeComposerText(text).catch(() => {});
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => void focusNativeComposer().catch(() => {}),
      setContent: putText,
      blurIfFocused: () => {
        if (focusedRef.current) void blurNativeComposer().catch(() => {});
      },
    }),
    [putText],
  );

  // Like any text box: the keyboard stays up while the log scrolls and closes
  // when the user taps somewhere else on the page (the native field itself sits
  // outside the web view, so a click here is always "elsewhere").
  useEffect(() => {
    const dismiss = (): void => {
      if (focusedRef.current) void blurNativeComposer().catch(() => {});
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const performSend = (text: string): void => {
      propsRef.current.onSend(text, propsRef.current.pendingImages);
      putText("");
      // Immediate flush, so the empty draft can't reappear if the app dies right after sending.
      draftRef.current.flush("");
      setTypo(null);
    };

    void listenNativeComposer({
      composerTextChange: ({ text }) => {
        textRef.current = text;
        setIsEmpty(text.length === 0);
        setTypo(null);
        draftRef.current.schedule(text.trim());
      },
      composerFocusChange: ({ focused }) => {
        focusedRef.current = focused;
        if (!focused) draftRef.current.flush(textRef.current.trim());
      },
      composerSubmit: ({ text: raw }) => {
        const text = raw.trim();
        textRef.current = raw;
        const decision = decideSubmit({
          text,
          attachmentCount: propsRef.current.pendingImages.length,
          uploading: propsRef.current.uploadingImage,
          confirmedTypoText: typoRef.current?.text ?? null,
          catalog: propsRef.current.modelCatalog,
        });
        if (decision.kind === "empty" || decision.kind === "uploading") return;
        if (decision.kind === "typo") {
          setTypo({ text, suggestion: decision.suggestion });
          return;
        }
        performSend(text);
      },
      composerStop: () => propsRef.current.onStop(),
      composerAttach: ({ files }) => {
        void (async () => {
          const read: File[] = [];
          for (const file of files) {
            try {
              const bytes = await readNativeAttachment(file.path);
              read.push(new File([bytes], file.name, { type: file.mimeType }));
            } catch (error) {
              console.error("[anywh] failed to read picked attachment:", file.path, error);
            }
          }
          if (read.length > 0) propsRef.current.onAddFiles(read);
        })();
      },
      composerRemoveAttachment: ({ path }) => propsRef.current.onRemoveImage(path),
      composerCancelEdit: () => propsRef.current.onCancelEdit(),
      composerTypoUse: () => {
        const current = typoRef.current;
        if (!current) return;
        putText(current.suggestion);
        setTypo(null);
      },
      composerTypoSendAnyway: () => {
        const current = typoRef.current;
        if (current) performSend(current.text);
      },
      composerScrollToEnd: () => propsRef.current.onScrollToEnd(),
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [putText]);

  return null;
});
