import { useState } from "react";
import { logTailLines, type RunningSubagent } from "@/lib/format/backgroundActivity";
import type { BackgroundJobSummary } from "@/lib/relay/relayClient";
import type { Profile } from "@/lib/profiles/profiles";
import { useBackgroundJobLog } from "@/hooks/useBackgroundJobLog";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { formatDurationLong } from "@/lib/utils";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";

interface LaunchedInBackgroundProps {
  profile: Profile;
  sessionId: string;
  /** Whether this conversation is on screen — a job's log is only re-read
   * while it is (see `useBackgroundJobLog`). */
  live: boolean;
  jobs: BackgroundJobSummary[];
  onCancelJob: (id: string) => void;
  /** Subagents still running — see `runningSubagents`. */
  agents: RunningSubagent[];
  /** Stops the whole turn: a subagent has no process of its own to stop. */
  onStopAgent: () => void;
}

/** How many log lines an expanded process card shows. */
const EXPANDED_LOG_LINES = 12;

function CardShell({
  open,
  onToggle,
  glyph,
  badge,
  badgeClassName,
  name,
  meta,
  latest,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  glyph: React.ReactNode;
  badge: string;
  badgeClassName: string;
  name: string;
  meta: string;
  /** What it's doing right now, one line — shown collapsed too, since "it's
   * running" without "doing what" is the part that leaves you guessing. */
  latest: string | null;
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
      {!open && latest && (
        <div title={latest} className="-mt-1 truncate px-2.5 pb-2 pl-8 font-mono text-[10.5px] text-text-faint">
          {latest}
        </div>
      )}
      {open && <div className="border-t border-border-soft bg-bg-chrome">{children}</div>}
    </div>
  );
}

/** Monospace lines under an expanded card — the job's log, or the
 * subagent's tool calls. */
function CardLines({ lines, empty }: { lines: string[]; empty: string }) {
  return (
    <pre className="max-h-48 overflow-y-auto px-2.5 py-2 pl-8 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
      {lines.length > 0 ? lines.join("\n") : <span className="text-text-faint">{empty}</span>}
    </pre>
  );
}

function ProcCard({
  profile,
  sessionId,
  live,
  job,
  open,
  onToggle,
  onCancel,
}: {
  profile: Profile;
  sessionId: string;
  live: boolean;
  job: BackgroundJobSummary;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const dict = useDict();
  const strings = dict.chat.launchedInBackground;
  const elapsedSeconds = useElapsedSeconds(job.startedAt);
  const log = useBackgroundJobLog(profile, sessionId, job.id, live);
  const lines = logTailLines(log.tail ?? "", EXPANDED_LOG_LINES);
  const emptyLog = log.status === "loading" ? strings.logLoading : log.status === "unavailable" ? strings.logUnavailable : strings.logEmpty;

  return (
    <CardShell
      open={open}
      onToggle={onToggle}
      glyph={<span className="size-2 shrink-0 bg-diff-add" />}
      badge={strings.procBadge}
      badgeClassName="border-border text-text-faint"
      name={job.label}
      meta={formatDurationLong(elapsedSeconds)}
      latest={lines[lines.length - 1] ?? null}
    >
      <CardLines lines={lines} empty={emptyLog} />
      <div className="flex items-center gap-1.5 border-t border-border-soft px-2.5 py-2 pl-8">
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

function AgentCard({ agent, open, onToggle, onStop }: { agent: RunningSubagent; open: boolean; onToggle: () => void; onStop: () => void }) {
  const dict = useDict();
  const strings = dict.chat.launchedInBackground;
  const elapsedSeconds = useElapsedSeconds(agent.startedAt ?? 0);
  const meta = [
    agent.startedAt === null ? null : formatDurationLong(elapsedSeconds),
    agent.toolUses === null
      ? null
      : agent.toolUses === 1
        ? strings.agentOneToolUse
        : strings.agentToolUses.replace("{count}", String(agent.toolUses)),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CardShell
      open={open}
      onToggle={onToggle}
      glyph={
        <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" />
      }
      badge={strings.agentBadge}
      badgeClassName="border-primary bg-primary-soft text-primary-ink"
      name={agent.description ?? strings.agentFallbackName}
      meta={meta}
      latest={agent.activity}
    >
      <CardLines lines={agent.toolCalls} empty={strings.agentNoToolCalls} />
      <div className="flex items-center gap-1.5 border-t border-border-soft px-2.5 py-2 pl-8">
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
export function LaunchedInBackground({
  profile,
  sessionId,
  live,
  jobs,
  onCancelJob,
  agents,
  onStopAgent,
}: LaunchedInBackgroundProps) {
  const dict = useDict();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());

  if (jobs.length === 0 && agents.length === 0) return null;

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

      {agents.map((agent) => (
        <AgentCard
          key={agent.toolUseId}
          agent={agent}
          open={openIds.has(agent.toolUseId)}
          onToggle={() => toggle(agent.toolUseId)}
          onStop={onStopAgent}
        />
      ))}
      {jobs.map((job) => (
        <ProcCard
          key={job.id}
          profile={profile}
          sessionId={sessionId}
          live={live}
          job={job}
          open={openIds.has(job.id)}
          onToggle={() => toggle(job.id)}
          onCancel={() => onCancelJob(job.id)}
        />
      ))}
    </div>
  );
}
