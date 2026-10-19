import { memo, useState, type KeyboardEvent } from "react";
import { AlertCircle, Check, ChevronRight, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/chat/activity/CodeBlock";
import { Elapsed, formatElapsed } from "@/components/chat/activity/Elapsed";
import { OutcomeView } from "@/components/chat/activity/OutcomeView";
import { ToolIcon } from "@/components/chat/activity/ToolIcon";
import { callDuration, callMeta, callTarget, verbKey } from "@/lib/format/activity";
import { formatTokenCount } from "@/lib/format/contextUsage";
import { useOpen } from "@/lib/format/openState";
import { relativeToCwd } from "@/lib/relay/toolCallSummary";
import { useDict } from "@/i18n";
import type { AttributionState, ToolCallEntry } from "@/hooks/relay/useMessageLog";

// Finding the Read that cost 13.5k is the point, not annotating forty Edits
// averaging ~111 tokens each — anything under this is noise on a row that
// already has a verb, a target and a detail.
const ATTRIBUTION_BADGE_FLOOR = 1000;

interface ToolCallRowProps {
  call: ToolCallEntry;
  attribution?: AttributionState;
  cwd: string | null;
  onCopy: (text: string) => void;
  /** Opens a file in the panel — `undefined` on compact/iOS, where there is
   * none, which also leaves the target as plain text. */
  onOpenPath?: (path: string) => void;
}

/** The label of a call's input line, and what follows it. Shell keeps the
 * conventional `$`; everything else names its field. */
function inputLine(call: ToolCallEntry, dict: ReturnType<typeof useDict>, cwd: string | null): { label: string; value: string } | undefined {
  const labels = dict.chat.activity.inputLabels;
  const subject = call.subject;
  if (!subject) return undefined;
  switch (subject.kind) {
    case "shell":
      return { label: "$", value: subject.command };
    case "read":
    case "edit":
    case "write":
      return { label: labels.path, value: subject.path };
    case "search":
      return {
        label: subject.mode === "files" ? labels.pattern : labels.regex,
        value: subject.path ? `${subject.pattern} · ${relativeToCwd(subject.path, cwd)}` : subject.pattern,
      };
    case "web":
      return subject.mode === "search" ? { label: labels.query, value: subject.query } : { label: labels.url, value: subject.url };
    case "mcp":
      return { label: labels.mcp, value: `${subject.server}.${subject.tool}` };
    case "task":
    case "other":
      return undefined;
  }
}

/** A call whose input line already says everything its arguments do (a path,
 * a command, a query) has nothing to add by repeating them as JSON. One with
 * no interpreted subject — an unknown tool — or an MCP call, whose line only
 * names the tool, would otherwise show nothing about what it was called with,
 * so its arguments get a block of their own. */
function showsArguments(call: ToolCallEntry): boolean {
  if (Object.keys(call.input).length === 0) return false;
  const kind = call.subject?.kind;
  return kind === undefined || kind === "mcp" || kind === "task" || kind === "other";
}

/** "420ms" for a call that ended fast, whole seconds after — the same clock
 * format as everything else in the log. */
function formatCallTime(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : formatElapsed(ms);
}

/** The copy button copies the result — the text the call produced — not the
 * input, which the row already shows. */
function CopyResult({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
  const dict = useDict();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      aria-label={copied ? dict.chat.activity.resultCopied : dict.chat.activity.copyResult}
      onClick={() => {
        onCopy(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** One call inside an expanded group: dim verb, target, detail on the
 * right; open it for the input and the result. Memoized like every row —
 * `call` keeps its identity until the call itself changes. */
export const ToolCallRow = memo(function ToolCallRow({ call, attribution, cwd, onCopy, onOpenPath }: ToolCallRowProps) {
  const dict = useDict();
  const [open, toggle] = useOpen(call.id);
  const activity = dict.chat.activity;
  const verbs = activity.verbs;
  const subject = call.subject;

  // The verb is the template without its target — it stays dim, and the
  // target beside it carries the emphasis.
  const tenses = verbs[verbKey(call)];
  const template = call.done ? tenses.past : tenses.ing;
  const verb = template.replace("{target}", "").trim();
  const target = callTarget(call);
  const openablePath = subject && (subject.kind === "read" || subject.kind === "edit" || subject.kind === "write") ? subject.path : undefined;
  const meta = callMeta(call, activity);
  const input = inputLine(call, dict, cwd);
  const failed = call.isError && !call.aborted;
  const duration = callDuration(call);
  const withArguments = showsArguments(call);

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  }

  return (
    <div className="bg-background">
      {/* A `div` acting as the toggle: the target inside it is a second
          action (open the file) and a button can't sit inside a button. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKey}
        className="flex cursor-pointer items-center gap-2.5 px-3 py-[9px] text-[13.5px] leading-snug transition-colors hover:bg-surface-hover"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <ToolIcon call={call} className="size-4 shrink-0 text-text-faint" />
          <span className="shrink-0 whitespace-nowrap text-text-faint">{verb}</span>
          {openablePath && onOpenPath ? (
            <button
              type="button"
              title={dict.chat.activity.openFile}
              className="min-w-0 cursor-pointer truncate font-mono text-[12.5px] text-foreground hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                onOpenPath(openablePath);
              }}
            >
              {target}
            </button>
          ) : (
            <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{target}</span>
          )}
          <ChevronRight className={cn("size-3 shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
        </span>
        <span className="flex shrink-0 items-center gap-[7px] font-mono text-[11px] text-text-faint">
          {meta?.kind === "diff" && (
            <span className="flex gap-1.5 font-medium">
              {meta.added > 0 && <span className="text-diff-add">+{meta.added}</span>}
              {meta.removed > 0 && <span className="text-destructive">−{meta.removed}</span>}
            </span>
          )}
          {meta?.kind === "text" && <span>{meta.text}</span>}
          {attribution && attribution.tokens >= ATTRIBUTION_BADGE_FLOOR && (
            <span title={attribution.estimated ? dict.chat.toolCall.attributionEstimatedHint : undefined}>
              +{formatTokenCount(attribution.tokens)}
              {attribution.estimated ? "~" : ""}
            </span>
          )}
          {/* The state, always on the right: still running, failed, or done.
              A call the user stopped is none of those, so it shows nothing. */}
          {!call.done ? (
            <>
              <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-border border-t-primary" aria-hidden />
              {call.startedAt !== undefined && <Elapsed startedAt={call.startedAt} />}
            </>
          ) : failed ? (
            <>
              <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
              <span className="text-destructive">{meta?.kind === "error" ? meta.text : activity.callFailed}</span>
            </>
          ) : !call.isError ? (
            <>
              <Check className="size-3.5 shrink-0 text-primary" strokeWidth={2.5} aria-hidden />
              {duration !== undefined && <span>{formatCallTime(duration)}</span>}
            </>
          ) : null}
        </span>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {input && (
            <div className="flex min-h-6 items-center gap-2 font-mono text-[11px]">
              <span className="shrink-0 text-text-faint">{input.label}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground">{input.value}</span>
              {/* With a Result block below, that block carries the copy button. */}
              {call.content !== undefined && !withArguments && <CopyResult text={call.content} onCopy={onCopy} />}
            </div>
          )}
          {withArguments && <CodeBlock label={activity.block.arguments} value={call.input} copyLabel={activity.block.copyArguments} onCopy={onCopy} />}
          {!call.done ? (
            <p className="font-mono text-[11px] text-text-faint">{activity.running}</p>
          ) : withArguments ? (
            // Nothing above carries the copy-result button here (that lives on
            // the input line), so the result brings its own label and button.
            call.outcome === undefined || call.outcome.kind === "text" ? (
              <CodeBlock label={activity.block.result} value={call.content ?? ""} copyLabel={activity.copyResult} onCopy={onCopy} />
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex min-h-6 items-center justify-between">
                  <span className="font-mono text-[10.5px] tracking-wide text-text-faint uppercase">{activity.block.result}</span>
                  {call.content !== undefined && <CopyResult text={call.content} onCopy={onCopy} />}
                </div>
                <OutcomeView call={call} cwd={cwd} />
              </div>
            )
          ) : (
            <OutcomeView call={call} cwd={cwd} />
          )}
        </div>
      )}
    </div>
  );
});
