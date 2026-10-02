import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { highlightLines } from "@/lib/format/highlightCode";
import { useDict } from "@/i18n";

export interface CodeLine {
  text: string;
  /** `hunk` is a diff's `@@ -a,b +c,d @@` header, drawn dim and unhighlighted. */
  kind: "add" | "del" | "context" | "hunk";
}

interface CodeLinesProps {
  language: string;
  lines: CodeLine[];
  /** Number of the first line: draws a gutter with line numbers. Absent =
   * no gutter — some code has no known offset, and numbering it from 1 would
   * be a lie. */
  startLine?: number;
}

const MARKER_BY_KIND: Record<CodeLine["kind"], string> = {
  add: "+",
  del: "-",
  context: " ",
  hunk: "",
};

// Only the first slice shows up right away — the rest sits behind "show
// more", like the Claude Code CLI's truncated preview in the terminal,
// instead of dumping the whole file/diff into the card.
const PREVIEW_LINE_COUNT = 14;

/** List of code lines colored by language — a read's content, a diff
 * (`DiffView`) or a new file (all added). The preview stops at a few lines
 * and the rest is one click away; even opened, the list scrolls inside a
 * bounded box, so a 2000-line read never takes over the conversation. */
export function CodeLines({ language, lines, startLine }: CodeLinesProps) {
  const dict = useDict();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINE_COUNT);
  const hiddenCount = lines.length - visible.length;

  // Highlighted as a single block (not one call per line) so the tokenizer's
  // state — e.g. "still inside a /* */ block comment" — carries across line
  // breaks; see `highlightLines`.
  const highlighted = useMemo(
    () => highlightLines(language, visible.map((line) => (line.kind === "hunk" ? "" : line.text))),
    [language, visible],
  );
  const gutterWidth = startLine === undefined ? 0 : String(startLine + lines.length).length;

  return (
    <div className={cn("overflow-x-auto border border-border bg-card font-mono text-xs", expanded && "max-h-96 overflow-y-auto")}>
      {visible.map((line, index) =>
        line.kind === "hunk" ? (
          <div key={index} className="border-t border-border-soft px-2 py-0.5 text-text-faint first:border-t-0">
            {line.text}
          </div>
        ) : (
          <div
            key={index}
            className={cn(
              "flex px-2 py-0.5 whitespace-pre",
              line.kind === "add" && "bg-diff-add/10",
              line.kind === "del" && "bg-destructive/10",
            )}
          >
            {startLine !== undefined && (
              <span className="mr-3 shrink-0 select-none text-right text-text-faint" style={{ minWidth: `${gutterWidth}ch` }}>
                {startLine + index}
              </span>
            )}
            <span
              className={cn(
                "mr-1 shrink-0 select-none",
                line.kind === "add" && "text-diff-add",
                line.kind === "del" && "text-destructive",
                line.kind === "context" && "text-muted-foreground",
              )}
            >
              {MARKER_BY_KIND[line.kind]}
            </span>
            <span>{highlighted[index]}</span>
          </div>
        ),
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full cursor-pointer border-t border-border-soft px-2 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          {dict.chat.code.showMoreLines.replace("{count}", String(hiddenCount))}
        </button>
      )}
    </div>
  );
}
