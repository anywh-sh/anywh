import { memo, useState, type KeyboardEvent } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Elapsed } from "@/components/chat/activity/Elapsed";
import { OutcomeView } from "@/components/chat/activity/OutcomeView";
import { callMeta, callTarget, verbKey } from "@/lib/format/activity";
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

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  }

  return (
    <div className="border-t border-border-soft first:border-t-0">
      {/* A `div` acting as the toggle: the target inside it is a second
          action (open the file) and a button can't sit inside a button. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKey}
        className="flex cursor-pointer items-baseline gap-2 py-1.5 text-xs transition-colors hover:bg-surface-hover"
      >
        {failed ? <span className="mt-1 size-[7px] shrink-0 self-start bg-destructive" aria-hidden /> : <ChevronRight className={cn("size-3 shrink-0 self-center text-text-faint transition-transform", open && "rotate-90")} />}
        <span className="shrink-0 text-text-faint">{verb}</span>
        {openablePath && onOpenPath ? (
          <button
            type="button"
            title={dict.chat.activity.openFile}
            className="min-w-0 cursor-pointer truncate font-mono text-[11.5px] text-foreground hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onOpenPath(openablePath);
            }}
          >
            {target}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">{target}</span>
        )}
        <span className="ml-auto flex shrink-0 items-baseline gap-2 pl-2 font-mono text-[10.5px] text-text-faint">
          {meta?.kind === "diff" && (
            <span className="flex gap-1.5 font-medium">
              {meta.added > 0 && <span className="text-diff-add">+{meta.added}</span>}
              {meta.removed > 0 && <span className="text-destructive">−{meta.removed}</span>}
            </span>
          )}
          {meta?.kind === "text" && <span>{meta.text}</span>}
          {meta?.kind === "error" && <span className="text-destructive">{meta.text}</span>}
          {attribution && attribution.tokens >= ATTRIBUTION_BADGE_FLOOR && (
            <span title={attribution.estimated ? dict.chat.toolCall.attributionEstimatedHint : undefined}>
              +{formatTokenCount(attribution.tokens)}
              {attribution.estimated ? "~" : ""}
            </span>
          )}
          {!call.done && call.startedAt !== undefined && <Elapsed startedAt={call.startedAt} />}
        </span>
      </div>

      {open && (
        <div className="flex flex-col gap-2 pb-2 pl-5">
          {input && (
            <div className="flex items-start gap-2 font-mono text-[11px]">
              <span className="shrink-0 text-text-faint">{input.label}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground">{input.value}</span>
              {call.content !== undefined && <CopyResult text={call.content} onCopy={onCopy} />}
            </div>
          )}
          {call.done ? <OutcomeView call={call} cwd={cwd} /> : <p className="font-mono text-[11px] text-text-faint">{activity.running}</p>}
        </div>
      )}
    </div>
  );
});
