import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CodeLines } from "@/components/chat/CodeLines";
import { DiffView } from "@/components/chat/DiffView";
import { languageForPath } from "@/lib/format/codeLanguage";
import { relativeToCwd } from "@/lib/relay/toolCallSummary";
import { useDict } from "@/i18n";
import type { ToolCallEntry } from "@/hooks/relay/useMessageLog";
import type { ToolOutcome } from "@/lib/relay/relay-types";

interface OutcomeViewProps {
  call: ToolCallEntry;
  cwd: string | null;
}

/** Every plain-text result is bounded: it scrolls inside its own box rather
 * than stretching the conversation. */
const BOX = "max-h-80 overflow-auto border border-border bg-card px-2 py-1.5 font-mono text-xs";

function Pre({ children, error }: { children: string; error?: boolean }) {
  return <pre className={cn(BOX, "whitespace-pre-wrap break-all", error && "text-destructive")}>{children}</pre>;
}

function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="font-mono text-[10.5px] text-text-faint">{label}</span>}
      {children}
    </div>
  );
}

/**
 * Draws a call's result from its normalized `outcome` alone — the same
 * renderers serve every runtime, because the relay already put each result
 * in one of these shapes. A call whose runtime couldn't interpret its result
 * (no `outcome`) shows the plain text it did report.
 */
export function OutcomeView({ call, cwd }: OutcomeViewProps) {
  const dict = useDict();
  const outcome: ToolOutcome = call.outcome ?? { kind: "text" };

  switch (outcome.kind) {
    case "code":
      return <CodeLines language={languageForPath(outcome.path)} startLine={outcome.startLine} lines={outcome.lines.map((text) => ({ text, kind: "context" as const }))} />;
    case "diff":
      return outcome.hunks.length > 0 ? <DiffView hunks={outcome.hunks} language={languageForPath(outcome.path)} /> : <Pre error={call.isError}>{call.content ?? ""}</Pre>;
    case "terminal":
      return <Pre error={call.isError}>{outcome.output || dict.chat.activity.noOutput}</Pre>;
    case "files":
      return <Pre>{outcome.paths.map((path) => relativeToCwd(path, cwd)).join("\n") || dict.chat.activity.noOutput}</Pre>;
    case "matches":
      return (
        <div className={cn(BOX, "flex flex-col gap-2")}>
          {outcome.matches.map((match, index) => (
            <div key={index} className="flex flex-col">
              {match.path && (
                <span className="text-text-faint">
                  {relativeToCwd(match.path, cwd)}
                  {match.line !== undefined && `:${match.line}`}
                </span>
              )}
              <span className="whitespace-pre-wrap break-all pl-3">{match.text}</span>
            </div>
          ))}
        </div>
      );
    case "links":
      return (
        <div className={cn(BOX, "flex flex-col gap-2")}>
          {outcome.results.map((link, index) => (
            <div key={index} className="flex flex-col">
              <span className="font-sans text-foreground">{link.title}</span>
              <span className="break-all text-text-faint">{link.url}</span>
            </div>
          ))}
        </div>
      );
    case "payload":
      return (
        <div className="flex flex-col gap-2">
          <Section label={dict.chat.activity.inputLabels.query}>
            <Pre>{outcome.request}</Pre>
          </Section>
          <Pre error={call.isError}>{outcome.response || dict.chat.activity.noOutput}</Pre>
        </div>
      );
    case "text":
      return <Pre error={call.isError}>{call.content || dict.chat.activity.noOutput}</Pre>;
  }
}
