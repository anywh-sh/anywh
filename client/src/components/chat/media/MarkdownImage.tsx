import type { ComponentPropsWithoutRef } from "react";
import { TextButton } from "@/components/ui/text-button";
import { looksLikeExternalUrl } from "@/lib/composer/filePathLinks";
import { chatMediaKind, isInlineDataImage, localMediaPath, mediaFileName } from "@/lib/media/chatMedia";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";
import { mediaAround, mediaDataAttributes, useChatMedia } from "@/components/chat/media/chatMediaContext";
import { MediaTile } from "@/components/chat/media/MediaTile";

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  title?: string;
  onOpenPath?: (path: string) => void;
}

/**
 * A Markdown image in a message (`![what it shows](/path/to/shot.png)`, the
 * form the relay asks agents to use). A local image or video becomes a tile
 * served by the relay. A remote URL becomes a link to it and is never loaded
 * on its own: an image request is how a prompt injection would carry data
 * out of the conversation, and the webview has no CSP to stop it. With no
 * conversation around it (the file panel's Markdown preview) the image is
 * its caption, as a path link where the panel can open one.
 */
export function MarkdownImage({ src, alt, title, onOpenPath }: MarkdownImageProps) {
  const media = useChatMedia();
  const caption = alt?.trim() || title?.trim() || undefined;

  // Written out in full: showing it fetches nothing.
  if (isInlineDataImage(src)) return <img src={src} alt={alt ?? ""} className="inline-block max-h-72 max-w-full" />;

  const path = localMediaPath(src);
  if (path === undefined) {
    if (src && looksLikeExternalUrl(src)) {
      return (
        <a href={src} rel="noopener noreferrer" title={src} onClick={(event) => handleExternalLinkClick(event, src)}>
          {caption ?? src}
        </a>
      );
    }
    return caption ? <span>{caption}</span> : null;
  }

  const kind = chatMediaKind(path);
  if (!media || !kind) {
    const label = caption ?? mediaFileName(path);
    return onOpenPath ? (
      <TextButton tone="none" className="prose-chat-path-link" onClick={() => onOpenPath(path)}>
        {label}
      </TextButton>
    ) : (
      <span>{label}</span>
    );
  }
  return <MediaTile item={{ path, kind, alt: caption }} />;
}

/**
 * Inline code that names an image or video (`` `/tmp/login.png` ``): it
 * opens the viewer, with the message's other media, wherever the chat runs —
 * on iOS too, where the file panel the other path links open doesn't exist.
 * `null` when the path isn't media or there's no conversation to open it in,
 * so the caller keeps its own handling.
 */
export function MediaPathLink({ path, ...props }: { path: string } & ComponentPropsWithoutRef<"button">) {
  const media = useChatMedia();
  const kind = chatMediaKind(path);
  if (!media || !kind) return null;
  return (
    <TextButton
      {...props}
      tone="none"
      className="prose-chat-path-link"
      onClick={(event) => {
        const { items, index } = mediaAround(event.currentTarget);
        media.open(items, index);
      }}
      {...mediaDataAttributes({ path, kind })}
    >
      {path}
    </TextButton>
  );
}

/** Whether `MediaPathLink` would draw something for `path` here — the
 * check `MarkdownContent` makes before falling back to its other links. */
export function useOpensAsMedia(path: string): boolean {
  return useChatMedia() !== null && chatMediaKind(path) !== undefined;
}
