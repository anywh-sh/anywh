import { useState } from "react";
import type { RunningTaskCall } from "@/lib/format/backgroundActivity";
import type { BackgroundJobSummary } from "@/lib/relay/relayClient";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { formatDurationLong } from "@/lib/utils";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";

interface LaunchedInBackgroundProps {
  jobs: BackgroundJobSummary[];
  onCancelJob: (id: string) => void;
  runningTaskCall: RunningTaskCall | undefined;
  onStopAgent: () => void;
}

function CardShell({
  open,
  onToggle,
  glyph,
  badge,
  badgeClassName,
  name,
  meta,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  glyph: React.ReactNode;
  badge: string;
  badgeClassName: string;
  name: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-bg-elevated"
      >
        <span className="w-2.5 shrink-0 font-mono text-[10px] text-text-faint">{open ? "▾" : "▸"}</span>
        {glyph}
        <span
          className={cn(
            "shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-medium tracking-wider",
            badgeClassName,
          )}
        >
          {badge}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{name}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-text-faint">{meta}</span>
      </button>
      {open && <div className="border-t border-border-soft bg-bg-chrome">{children}</div>}
    </div>
  );
}

function ProcCard({
  job,
  open,
  onToggle,
  onCancel,
}: {
  job: BackgroundJobSummary;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const dict = useDict();
  const strings = dict.chat.launchedInBackground;
  const elapsedSeconds = useElapsedSeconds(job.startedAt);

  return (
    <CardShell
      open={open}
      onToggle={onToggle}
      glyph={<span className="size-2 shrink-0 bg-diff-add" />}
      badge={strings.procBadge}
      badgeClassName="border-border text-text-faint"
      name={job.label}
      meta={formatDurationLong(elapsedSeconds)}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-2 pl-8">
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer border border-destructive px-2 py-1 font-mono text-[10.5px] font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
        >
          {strings.stopProcess}
        </button>
      </div>
    </CardShell>
  );
}

function AgentCard({ call, open, onToggle, onStop }: { call: RunningTaskCall; open: boolean; onToggle: () => void; onStop: () => void }) {
  const dict = useDict();
  const strings = dict.chat.launchedInBackground;

  return (
    <CardShell
      open={open}
      onToggle={onToggle}
      glyph={
        <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" />
      }
      badge={strings.agentBadge}
      badgeClassName="border-primary bg-primary-soft text-primary-ink"
      name={call.description ?? strings.agentFallbackName}
      meta=""
    >
      <div className="flex items-center gap-1.5 px-2.5 py-2 pl-8">
        <button
          type="button"
          onClick={onStop}
          className="cursor-pointer border border-destructive px-2 py-1 font-mono text-[10.5px] font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
        >
          {strings.stopAgent}
        </button>
      </div>
    </CardShell>
  );
}

/**
 * Cards for background work launched from THIS conversation, above the
 * streaming indicator — replaces `BackgroundJobIndicator` on desktop (see
 * that component's own doc comment for why a separate chip existed; this
 * folds the same `anywh-bg` data into inline cards instead, plus a subagent
 * card the old chip never had).
 */
export function LaunchedInBackground({ jobs, onCancelJob, runningTaskCall, onStopAgent }: LaunchedInBackgroundProps) {
  const dict = useDict();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  if (jobs.length === 0 && !runningTaskCall) return null;

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 font-mono text-[10px] font-medium tracking-widest text-text-faint uppercase">
          {dict.chat.launchedInBackground.heading}
        </span>
        <span className="h-px flex-1 bg-border-soft" />
      </div>

      {runningTaskCall && (
        <AgentCard
          call={runningTaskCall}
          open={openIds.has(runningTaskCall.toolUseId)}
          onToggle={() => toggle(runningTaskCall.toolUseId)}
          onStop={onStopAgent}
        />
      )}
      {jobs.map((job) => (
        <ProcCard
          key={job.id}
          job={job}
          open={openIds.has(job.id)}
          onToggle={() => toggle(job.id)}
          onCancel={() => onCancelJob(job.id)}
        />
      ))}
    </div>
  );
}
