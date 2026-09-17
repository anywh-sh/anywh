import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/chat/DiffView";
import { CodeLines } from "@/components/chat/CodeLines";
import { languageForPath } from "@/lib/format/codeLanguage";
import { countDiffLines, relativeToCwd } from "@/lib/relay/toolCallSummary";
import { useDict } from "@/i18n";
import type { LogEntry } from "@/hooks/relay/useMessageLog";

interface ToolCallCardProps {
  use: Extract<LogEntry, { kind: "tool-use" }>;
  result?: Extract<LogEntry, { kind: "tool-result" }>;
  /** The session's working directory, so the header can show the file the
   * way the user would name it instead of the relay's absolute path.
   * `null` until the first `cwd_state` arrives. */
  cwd: string | null;
  /** Opens the touched file in the work dir file panel — `undefined` on
   * compact/iOS, where that panel doesn't exist, which is also what hides
   * the "view file" button. */
  onOpenPath?: (path: string) => void;
}

function formatParamValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function filePathOf(use: ToolCallCardProps["use"]): string | undefined {
  return typeof use.input?.file_path === "string" ? use.input.file_path : undefined;
}

/** What the header line says the call is about, when it isn't a file: the
 * command for Bash, the agent's own description otherwise. */
function summaryFor(use: ToolCallCardProps["use"]): string | undefined {
  const input = use.input;
  if (!input) return undefined;
  if (use.name === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.description === "string") return input.description;
  return undefined;
}

/** Memoized — see comment on `Message.tsx::UserBubble`. `use`/`result` are
 * the same objects from `useMessageLog`'s reducer as long as the entry
 * doesn't change, so `memo` actually bails out (not just an empty
 * shallow-compare) during the streaming of other messages in the
 * conversation. `cwd` is a string and `onOpenPath` comes from a ref in
 * `ChatPanel`, so neither breaks that. */
export const ToolCallCard = memo(function ToolCallCard({ use, result, cwd, onOpenPath }: ToolCallCardProps) {
  const dict = useDict();
  // Edit/Write already open right away — the content (diff or new file) is
  // what matters to see up front, same as Claude Code's automatic preview
  // in the terminal, instead of requiring another click to see what changed.
  const [open, setOpen] = useState(() => use.name === "Edit" || use.name === "Write");
  const filePath = filePathOf(use);
  const summary = filePath ? relativeToCwd(filePath, cwd) : summaryFor(use);
  const isError = result?.isError === true;
  const language = languageForPath(filePath);
  const writeContent = use.name === "Write" && typeof use.input?.content === "string" ? use.input.content : undefined;
  const counts = result?.structuredPatch ? countDiffLines(result.structuredPatch) : undefined;

  return (
    <div className={cn("border bg-card", isError ? "border-destructive/40" : "border-border")}>
      {/* The row is a `div` with the toggle as its first child rather than
          one big `button`: "view file" is a second action on the same line,
          and a button can't be nested inside a button. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-hover"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
          {/* The tool's name as an eyebrow tag, not an icon: with a dozen
              tools the icons were a legend nobody had, and the name is
              already short enough to read at a glance. */}
          <Badge variant="secondary">{use.name}</Badge>
          {summary && <span className="truncate font-mono text-[11.5px] text-muted-foreground">{summary}</span>}
          {counts && (counts.added > 0 || counts.removed > 0) && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] font-medium">
              {counts.added > 0 && <span className="text-diff-add">+{counts.added}</span>}
              {counts.removed > 0 && <span className="text-destructive">−{counts.removed}</span>}
            </span>
          )}
        </button>
        {filePath && onOpenPath && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mr-1.5 shrink-0"
            onClick={() => onOpenPath(filePath)}
          >
            {dict.chat.toolCall.viewFile}
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t border-border-soft px-2.5 py-2 text-xs">
          {use.name === "Edit" && result?.structuredPatch ? (
            <>
              <DiffView hunks={result.structuredPatch} language={language} />
              {isError && <p className="mt-2 text-destructive">{result.content}</p>}
            </>
          ) : writeContent !== undefined ? (
            <>
              <CodeLines language={language} lines={writeContent.split("\n").map((text) => ({ text, kind: "add" as const }))} />
              {isError && result && <p className="mt-2 text-destructive">{result.content}</p>}
            </>
          ) : (
            <>
              {use.input && Object.keys(use.input).length > 0 && (
                <div className="mb-2 flex flex-col gap-0.5 font-mono">
                  {Object.entries(use.input).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">{key}:</span>
                      <span className="whitespace-pre-wrap break-all text-foreground">{formatParamValue(value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {result && (
                <pre className={cn("overflow-x-auto whitespace-pre-wrap", isError ? "text-destructive" : "text-foreground")}>
                  {result.content}
                </pre>
              )}
              {!result && <p className="text-muted-foreground">{dict.chat.toolCall.running}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
});
