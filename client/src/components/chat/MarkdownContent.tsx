import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { handleExternalLinkClick } from "@/lib/platform/externalLink";
import { looksLikeExternalUrl, looksLikeFilePath } from "@/lib/composer/filePathLinks";
import { MarkdownCodeBlock } from "@/components/chat/MarkdownCodeBlock";

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
 */
export function MarkdownContent({ text, onOpenPath }: { text: string; onOpenPath?: (path: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
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
                <button type="button" className="prose-chat-path-link" onClick={() => onOpenPath(href)}>
                  {children}
                </button>
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
        // Only inline spans (no `className` — react-markdown/remark only
        // stamps `language-xxx` on a fenced block's `code`, never on an
        // inline one) are candidates: a fenced block's own `code` still
        // renders through here as a second pass, and linkifying paths
        // inside real code snippets would fight rehype-highlight's spans
        // for the same text.
        code: ({ className, children, ...props }) => {
          const text = typeof children === "string" ? children : String(children);
          if (!className) {
            if (onOpenPath && looksLikeFilePath(text)) {
              return (
                <button type="button" className="prose-chat-path-link" onClick={() => onOpenPath(text)}>
                  {text}
                </button>
              );
            }
            // A URL written as backtick code (`` `https://example.com` ``)
            // instead of a real markdown link — a common enough style choice
            // from the assistant that it's worth making clickable too,
            // instead of leaving it as inert styled text.
            if (looksLikeExternalUrl(text)) {
              return (
                <a href={text} rel="noopener noreferrer" className="prose-chat-path-link" onClick={(event) => handleExternalLinkClick(event, text)}>
                  {text}
                </a>
              );
            }
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
