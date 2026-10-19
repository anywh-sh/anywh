import { memo } from "react";
import { FileText, Globe, Plug, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOpen } from "@/lib/format/openState";
import { useDict } from "@/i18n";
import type { WorkTarget, WorkTargetKind } from "@/lib/format/activity";

/** Chips shown before "+N more" takes over the rest. */
const VISIBLE_CHIPS = 4;

const ICONS: Record<WorkTargetKind, LucideIcon> = {
  file: FileText,
  command: Terminal,
  query: Search,
  domain: Globe,
  app: Plug,
  other: Wrench,
};

/** Files, commands and search terms are code: set in mono. A host or an app
 * is a name: set in the UI face. */
const MONO: ReadonlySet<WorkTargetKind> = new Set<WorkTargetKind>(["file", "command", "query", "other"]);

interface TargetChipsProps {
  /** The step's id — the open state of "+N more" is its own, per step. */
  stepId: string;
  targets: WorkTarget[];
  /** Calls of the step that failed; their chips are tinted. */
  failedCallIds: ReadonlySet<string>;
  /** Opens a file in the panel — `undefined` on compact/iOS, where there is
   * none, which also leaves a file chip as plain text. */
  onOpenPath?: (path: string) => void;
}

/**
 * What a step acted on: one chip per file, command, term, host or app, at
 * most four to start with. The rest wait behind "+N more", which opens them
 * all and turns into "Show less". A long label is cut with an ellipsis (the
 * whole text is in the tooltip) and never widens the row.
 */
export const TargetChips = memo(function TargetChips({ stepId, targets, failedCallIds, onOpenPath }: TargetChipsProps) {
  const work = useDict().chat.activity.work;
  const [all, toggleAll] = useOpen(`targets:${stepId}`);
  const hidden = targets.length - VISIBLE_CHIPS;
  const shown = all || hidden <= 0 ? targets : targets.slice(0, VISIBLE_CHIPS);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {shown.map((target) => {
        const Icon = ICONS[target.kind];
        const failed = failedCallIds.has(target.callId);
        const chip = cn(
          "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 border px-2 text-xs",
          failed ? "border-destructive/25 bg-destructive/10 text-foreground" : "border-border-soft bg-card text-foreground",
        );
        const body = (
          <>
            <Icon className={cn("size-3 shrink-0", failed ? "text-destructive" : "text-text-faint")} aria-hidden />
            <span className={cn("min-w-0 truncate", MONO.has(target.kind) && "font-mono")}>{target.label}</span>
            {target.diff && (
              <span className="shrink-0 whitespace-nowrap font-mono text-text-faint">
                <span className="text-diff-add">+{target.diff.added}</span> <span className="text-destructive">−{target.diff.removed}</span>
              </span>
            )}
          </>
        );
        return target.kind === "file" && onOpenPath ? (
          <button
            key={target.callId}
            type="button"
            title={target.full}
            onClick={() => {
              onOpenPath(target.full);
            }}
            className={cn(chip, "cursor-pointer transition-colors hover:bg-surface-hover")}
          >
            {body}
          </button>
        ) : (
          <span key={target.callId} title={target.full} className={chip}>
            {body}
          </span>
        );
      })}
      {hidden > 0 && (
        <button type="button" onClick={toggleAll} aria-expanded={all} className="h-6 cursor-pointer px-1 text-xs text-text-faint transition-colors hover:text-muted-foreground">
          {all ? work.showLess : work.moreTargets.replace("{count}", String(hidden))}
        </button>
      )}
    </div>
  );
});
