import { useState } from "react";
import { ChevronLeft, Forward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { ChoiceCard } from "@/components/chat/ChoiceCard";
import { TaskStatusIcon } from "@/components/bots/BotPanel";
import { useRelayClient } from "@/hooks/relay/useRelayClient";
import { useDict, useLocale } from "@/i18n";
import { answerTask, cancelTask } from "@/lib/bots/botClient";
import { shortWhen } from "@/lib/bots/botStatusLine";
import { isClosedTask, type BotTask, type BotView, type BotWorkerView } from "@/lib/bots/botTypes";
import type { Profile } from "@/lib/profiles/profiles";

interface BotTaskDetailProps {
  profile: Profile;
  bot: BotView;
  task: BotTask;
  onBack: () => void;
  onOpenSession: (sessionId: string, title: string | null) => void;
}

/**
 * One task of a bot: what it is, what makes it done, the question waiting on
 * it (the bot's, or one of its agents'), answerable here, the agents working
 * on it, and its history.
 */
export function BotTaskDetail({ profile, bot, task, onBack, onOpenSession }: BotTaskDetailProps) {
  const dict = useDict();
  const { locale } = useLocale();
  const [error, setError] = useState(false);
  const asking = task.workers.find((worker) => worker.state === "awaiting_user");
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-3 pt-2 pb-4" data-testid="bot-task-detail">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={onBack}>
            <ChevronLeft />
            {dict.bots.task.back}
          </Button>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-text-faint">#{task.n}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <TaskStatusIcon status={task.status} />
            <span className={task.status === "needs_you" ? "text-primary" : undefined}>{dict.bots.task.status[task.status]}</span>
          </span>
          <h3 className="text-[15px] leading-snug font-medium text-foreground">{task.title}</h3>
          {task.from && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground" data-testid="bot-task-from">
              <Forward className="size-3 shrink-0" aria-hidden />
              {task.from.name === null ? dict.bots.task.fromGone : dict.bots.task.from.replace("{name}", task.from.name)}
            </span>
          )}
        </div>

        {task.question && (
          <ChoiceCard
            key={`${String(task.n)}:${String(task.question.askedAt)}`}
            promptId={`${bot.id}:${String(task.n)}:${String(task.question.askedAt)}`}
            kind="choice"
            questions={[
              {
                question: task.question.question,
                options: task.question.options.map((label, index) => ({ label, ...(index === task.question?.recommended ? { description: dict.bots.task.recommended } : {}) })),
              },
            ]}
            onAnswer={(answers) => {
              const answer = answers[0]?.selected.join(", ").trim();
              if (!answer) return;
              setError(false);
              answerTask(profile, bot.id, task.n, answer).catch(() => setError(true));
            }}
          />
        )}
        {!task.question && asking && <WorkerQuestion profile={profile} worker={asking} />}
        {error && <p className="text-xs text-destructive">{dict.bots.task.answerFailed}</p>}

        {task.doneMeans && (
          <section className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-text-faint">{dict.bots.task.doneMeans}</span>
            <p className="border-l-2 border-border pl-2.5 text-[13px] leading-relaxed text-foreground/90">{task.doneMeans}</p>
          </section>
        )}

        {task.workers.length > 0 && (
          <section className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-text-faint">{dict.bots.task.workers}</span>
            {task.workers.map((worker) => (
              <RowButton key={worker.agentId} size="auto" className="min-h-[30px] gap-2 border border-border py-1" disabled={worker.state === "gone"} onClick={() => onOpenSession(worker.agentId, worker.title)}>
                <WorkerStateIcon worker={worker} />
                <span className="min-w-0 flex-1 truncate">{worker.title ?? worker.agentId.slice(0, 8)}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-text-faint">{workerStateLabel(worker, dict.bots.task.worker)}</span>
              </RowButton>
            ))}
          </section>
        )}

        {task.notes.length > 0 && (
          <section className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-text-faint">{dict.bots.task.history}</span>
            {[...task.notes].reverse().map((note, index) => (
              <div key={`${String(note.at)}:${String(index)}`} className="flex gap-2.5 text-[12.5px]">
                <span className="w-16 shrink-0 font-mono text-[10.5px] leading-5 whitespace-nowrap text-text-faint">{shortWhen(note.at, locale)}</span>
                <span className="min-w-0 flex-1 leading-5 text-foreground/85">{note.text}</span>
              </div>
            ))}
          </section>
        )}

        {!isClosedTask(task.status) && (
          <Button
            variant="destructive-outline"
            size="xs"
            className="self-start"
            onClick={() => {
              setError(false);
              cancelTask(profile, bot.id, task.n).catch(() => setError(true));
            }}
          >
            {dict.bots.task.cancel}
          </Button>
        )}
      </div>
    </ScrollArea>
  );
}

/** An agent of the task waiting for the person: its question, from its own
 * session, answerable here (its socket is held only while this shows). */
function WorkerQuestion({ profile, worker }: { profile: Profile; worker: BotWorkerView }) {
  const dict = useDict();
  const session = useRelayClient(profile, worker.agentId);
  const prompt = session.choicePrompt;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] text-primary">{dict.bots.task.workerAsks}</span>
      {prompt ? (
        <ChoiceCard key={prompt.promptId} promptId={prompt.promptId} questions={prompt.questions} kind={prompt.kind} onAnswer={(answers) => session.answerChoice(answers)} />
      ) : (
        <Spinner size="sm" />
      )}
    </div>
  );
}

function WorkerStateIcon({ worker }: { worker: BotWorkerView }) {
  if (worker.state === "working" || worker.state === "queued") return <Spinner size="sm" />;
  if (worker.state === "awaiting_user") return <span aria-hidden className="mx-[3px] size-1.5 shrink-0 rounded-full bg-primary" />;
  return <span aria-hidden className="mx-[2px] size-2 shrink-0 border border-text-faint" />;
}

function workerStateLabel(worker: BotWorkerView, labels: { working: string; waiting: string; done: string; failed: string; stopped: string; gone: string }): string {
  switch (worker.state) {
    case "working":
    case "queued":
    case "waiting":
      return labels.working;
    case "awaiting_user":
      return labels.waiting;
    case "done":
      return labels.done;
    case "failed":
    case "blocked":
      return labels.failed;
    case "stopped":
      return labels.stopped;
    case "gone":
      return labels.gone;
  }
}
