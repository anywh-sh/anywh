import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { highlightLines } from "@/lib/format/highlightCode";
import { languageForPath } from "@/lib/format/codeLanguage";

interface CodeFileViewProps {
  path: string;
  content: string;
}

// Monospace + `whitespace-pre` (no wrap) gives every line the exact same
// height — unlike `MessageLog`'s bubbles, there's no need for
// `measureElement`/dynamic sizing here, a fixed `estimateSize` is exact, not
// an estimate.
const LINE_HEIGHT = 20;

/**
 * Read-only code viewer — line numbers + syntax highlight, virtualized
 * (`@tanstack/react-virtual`) so opening a huge file doesn't mean mounting
 * thousands of DOM nodes. Highlighting runs once for the whole file (not
 * per line): that's what lets the tokenizer carry state across lines (e.g.
 * still inside a block comment), see `highlightLines`.
 */
export function CodeFileView({ path, content }: CodeFileViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split("\n"), [content]);
  const language = useMemo(() => languageForPath(path), [path]);
  const highlighted = useMemo(() => highlightLines(language, lines), [language, lines]);
  const gutterWidth = String(lines.length).length;

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  return (
    <div ref={parentRef} className="selectable-content scrollbar-thin h-full overflow-auto bg-bg-chrome font-mono text-xs">
      <div style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            className="absolute top-0 left-0 flex w-full whitespace-pre"
            style={{ height: LINE_HEIGHT, transform: `translateY(${virtualItem.start}px)` }}
          >
            {/* The gutter is a surface of its own, a shade lighter than the
              * code and divided from it — numbers are furniture, not
              * content, and this keeps them from reading as a first column
              * of the file. */}
            <span
              className="shrink-0 border-r border-border-soft bg-bg-sidebar px-2 text-right text-text-faint select-none"
              style={{ minWidth: `${gutterWidth + 2}ch` }}
            >
              {virtualItem.index + 1}
            </span>
            <span className="pr-4 pl-3">{highlighted[virtualItem.index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
