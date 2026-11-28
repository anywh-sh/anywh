import { TextButton } from "@/components/ui/text-button";
import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";
import { looksLikeExternalUrl, looksLikeFilePath } from "@/lib/composer/filePathLinks";
import { MarkdownCodeBlock } from "@/components/chat/MarkdownCodeBlock";
import { MarkdownImage, MediaPathLink } from "@/components/chat/media/MarkdownImage";
import { useOpensAsMedia } from "@/components/chat/media/chatMediaContext";
import { MediaGallery } from "@/components/chat/media/MediaGallery";
import { remarkUserMessage, USER_MESSAGE_REHYPE_OPTIONS } from "@/lib/format/remarkUserMessage";
import { MEDIA_GALLERY_PROPERTY, remarkMediaGallery } from "@/lib/media/remarkMediaGallery";

const REMARK_PLUGINS = [remarkGfm, remarkMediaGallery];
const USER_REMARK_PLUGINS = [remarkGfm, remarkUserMessage, remarkMediaGallery];

/** react-markdown blanks a `file://` URL as unsafe. An image's is a local
 * path this app shows through the relay (`MarkdownImage`), never a `src`
 * handed to the webview as is, so for an image it is kept. */
const urlTransform: UrlTransform = (url, key, node) =>
  key === "src" && node.tagName === "img" && /^file:\/\//i.test(url) ? url : defaultUrlTransform(url);

/** `onOpenPath` for the overrides below, which are module-level components
 * (not closures over the prop) so their identity holds across renders: a
 * new function per render would be a new component type to React, and a
 * streaming reply re-renders on every token — each one remounting every
 * media tile in it, back to its loading state. */
const OpenPathContext = createContext<((path: string) => void) | undefined>(undefined);

/** A cell with at most this many characters never wraps. Table layout shares
 * the width out in proportion to each column's text, so a short column next to
 * a long one gets a sliver and wraps ("14 + até 30" over three lines) while the
 * long one has room to spare. Keeping short text on one line is what makes the
 * long column the one that wraps. */
const SHORT_CELL_MAX_CHARS = 20;

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

type CellProps = ComponentPropsWithoutRef<"td"> & { node?: unknown };

function tableCell(Tag: "td" | "th") {
  return function TableCell({ node: _node, children, className, ...props }: CellProps) {
    const short = textOf(children).trim().length <= SHORT_CELL_MAX_CHARS;
    return (
      <Tag {...props} className={short ? `${className ?? ""} whitespace-nowrap`.trim() : className}>
        {children}
      </Tag>
    );
  };
}
const TableTd = tableCell("td");
const TableTh = tableCell("th");

type ImgProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

function MarkdownImg({ src, alt, title }: ImgProps) {
  const onOpenPath = useContext(OpenPathContext);
  return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} onOpenPath={onOpenPath} />;
}

type DivProps = ComponentPropsWithoutRef<"div"> & { node?: { properties?: Record<string, unknown> } };

/** A gallery `remarkMediaGallery` made; any other `div` as it came. */
function MarkdownDiv({ node, children, ...props }: DivProps) {
  if (node?.properties?.[MEDIA_GALLERY_PROPERTY] !== undefined) return <MediaGallery>{children}</MediaGallery>;
  return <div {...props}>{children}</div>;
}

type CodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

/** Only inline spans (no `className` — react-markdown/remark only stamps
 * `language-xxx` on a fenced block's `code`, never on an inline one) are
 * candidates: a fenced block's own `code` still renders through here as a
 * second pass, and linkifying paths inside real code snippets would fight
 * rehype-highlight's spans for the same text. */
function MarkdownCode({ node: _node, className, children, ...props }: CodeProps) {
  const onOpenPath = useContext(OpenPathContext);
  const text = typeof children === "string" ? children : String(children);
  const inlinePath = !className && looksLikeFilePath(text);
  const opensAsMedia = useOpensAsMedia(text);
  if (inlinePath && opensAsMedia) return <MediaPathLink path={text} />;
  if (inlinePath && onOpenPath) {
    return (
      <TextButton tone="none" className="prose-chat-path-link" onClick={() => onOpenPath(text)}>
        {text}
      </TextButton>
    );
  }
  // A URL written as backtick code (`` `https://example.com` ``) instead of a
  // real markdown link — a common enough style choice from the assistant
  // that it's worth making clickable too, instead of leaving it as inert
  // styled text.
  if (!className && looksLikeExternalUrl(text)) {
    return (
      <a href={text} rel="noopener noreferrer" className="prose-chat-path-link" onClick={(event) => handleExternalLinkClick(event, text)}>
        {text}
      </a>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

/**
 * GFM + syntax-highlighted code blocks + external links opened via the
 * platform's own handler — extracted from `AssistantText` so the
 * work dir file panel's markdown viewer can render `.md` files the exact
 * same way the chat does, without duplicating the plugin list or the link
 * handling.
 *
 * `onOpenPath` is optional — only the chat call site (`Message.tsx`) wires
 * it up (desktop only, matching the file panel itself); the file panel's
 * own `.md` viewer (`MarkdownFileView`) reuses this component without it,
 * so an inline path mentioned inside a previewed markdown file just renders
 * as plain code, unchanged.
 *
 * `userMessage` is for text a person typed rather than an agent wrote — see
 * `remarkUserMessage` for what it changes.
 */
export function MarkdownContent({
  text,
  onOpenPath,
  userMessage = false,
}: {
  text: string;
  onOpenPath?: (path: string) => void;
  userMessage?: boolean;
}) {
  return (
    <OpenPathContext.Provider value={onOpenPath}>
    <ReactMarkdown
      remarkPlugins={userMessage ? USER_REMARK_PLUGINS : REMARK_PLUGINS}
      remarkRehypeOptions={userMessage ? USER_MESSAGE_REHYPE_OPTIONS : undefined}
      rehypePlugins={[rehypeHighlight]}
      urlTransform={urlTransform}
      components={{
        // Cells wrap at `break-word` (see `.prose-chat th`), which keeps short
        // columns from collapsing but lets one long unbreakable string widen
        // the table past the message — the wrapper turns that into a
        // horizontal scroll instead of clipped columns.
        table: ({ children }) => (
          <div className="prose-chat-table scrollbar-thin">
            <table>{children}</table>
          </div>
        ),
        td: TableTd,
        th: TableTh,
        // A real markdown link (`[foo](bar/baz.ts)`, as opposed to the `code`
        // override below) whose `href` isn't an external URL scheme: the
        // opener plugin's scope only knows http(s)/mailto/tel/the editor
        // deep links (capabilities/default.json), so handing it a bare path
        // fails closed and the click silently does nothing. Route it through
        // the same file panel affordance as an inline-code path instead.
        a: ({ href, children, ...props }) => {
          if (href && !looksLikeExternalUrl(href)) {
            if (onOpenPath) {
              return (
                <TextButton tone="none" className="prose-chat-path-link" onClick={() => onOpenPath(href)}>
                  {children}
                </TextButton>
              );
            }
            return <span>{children}</span>;
          }
          return (
            <a {...props} href={href} rel="noopener noreferrer" onClick={(event) => href && handleExternalLinkClick(event, href)}>
              {children}
            </a>
          );
        },
        pre: MarkdownCodeBlock,
        code: MarkdownCode,
        img: MarkdownImg,
        div: MarkdownDiv,
      }}
    >
      {text}
    </ReactMarkdown>
    </OpenPathContext.Provider>
  );
}
