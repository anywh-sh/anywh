import { memo, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TitleSkeleton } from "@/components/ui/title-skeleton";
import { useDict } from "@/i18n";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { cn } from "@/lib/utils";
import { cardActivity, cardClock, cardLines, cardStatus, formatClock, type CardClock } from "@/lib/sala/agentCard";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { CheckIcon, CloseIcon, ConversationGlyph, AreaIcon, QuestionIcon, TrashIcon } from "@/components/sala/SalaIcons";
import { useSecondTick } from "@/components/sala/useSecondTick";
import { prefersReducedMotion } from "@/components/sala/useArrivals";

export interface SalaCardProps {
  agent: RoomAgent;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  hasParent: boolean;
  hasKids: boolean;
  modelLabel: string;
  /** This card's question is open under it. */
  answering: boolean;
  /** Workers in the room: what a working principal says it coordinates. */
  workers: number;
  /** Of those, the ones working or about to: what makes a principal that has
   * finished delegating still read as running. */
  liveWorkers: number;
  /** When this screen first saw the agent in its present state. */
  observedSince: number;
  /** Where this card is in its arrival (`useArrivals`): unseen while its link
   * draws, then opening. */
  boot?: "edge" | "frame";
  /** A card this one just delegated to is arriving: its bottom port lights up. */
  delegating?: boolean;
  canGroup: boolean;
  canStop: boolean;
  canRemove: boolean;
  onPointerDown: (agentId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onSelect: (agentId: string) => void;
  onOpen: (agentId: string) => void;
  onDelegate: (agentId: string) => void;
  onReply: (agentId: string) => void;
  onGroup: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}

export function Clock({ clock }: { clock: CardClock }) {
  const dict = useDict().sala.card.clock;
  const now = useSecondTick();
  if (clock.kind === "none") return null;
  if (clock.kind === "starting") return <>{dict.starting}</>;
  if (clock.took !== undefined && (clock.kind === "done" || clock.kind === "failed" || clock.kind === "blocked")) {
    return <>{dict[`${clock.kind}Took`].replace("{time}", formatClock(clock.took))}</>;
  }
  return <>{dict[clock.kind].replace("{time}", formatClock(now - clock.since))}</>;
}

/** How long the toolbar takes to fade out once its card is deselected. */
export const BAR_CLOSE_MS = 120;

/** Whether the toolbar is shown, and whether it is on its way out: it stays
 * mounted for its fade after the card is deselected, inert meanwhile. */
function useBarPresence(open: boolean): "open" | "closing" | null {
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), BAR_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return open ? "open" : closing ? "closing" : null;
}

/** How far into its run a running agent is, counting up. */
function LiveAt({ since }: { since: number }) {
  const now = useSecondTick();
  return <>{formatClock(now - since)}</>;
}

/**
 * One agent's card, drawn as a small terminal window: a title bar with the
 * state, a log of what the agent did and is doing, and a strip with the
 * runtime, the model and the time (or the way to answer it). Positioned by
 * `transform` alone (the canvas moves it during a drag by writing that same
 * property), so a card is never laid out again for being moved. Memoized:
 * only the cards whose agent changed render when the channel reports a
 * change.
 */
export const SalaCard = memo(function SalaCard(props: SalaCardProps) {
  const { agent, x, y, w, h, selected, hasParent, hasKids, modelLabel, workers, liveWorkers, observedSince } = props;
  const fullDict = useDict();
  const dict = fullDict.sala.card;
  const chatWork = fullDict.chat.activity.work;
  const status = cardStatus(agent, liveWorkers);
  const activity = cardActivity(agent, workers, liveWorkers);
  const clock = cardClock(agent, observedSince, liveWorkers);
  const title = agent.title ?? dict.untitled;
  const main = agent.role === "principal";
  const bar = useBarPresence(selected);
  const lines = cardLines(agent, status);

  const activityText = ((): string => {
    switch (activity.kind) {
      case "coordinating":
        return activity.agents === 1 ? dict.activity.coordinatingOne : dict.activity.coordinating.replace("{count}", String(activity.agents));
      case "working":
        return activity.subtasks > 0 ? dict.activity.workingSubtasks.replace("{count}", String(activity.subtasks)) : dict.activity.working;
      case "needsApproval":
        return dict.activity.needsApproval;
      case "needsAnswer":
        return dict.activity.needsAnswer;
      case "report":
        return activity.text === "" ? dict.activity.noReport : activity.text;
      case "queued":
        return dict.activity.queued;
      case "stopped":
        return dict.activity.stopped;
      case "idle":
        return status.tone === "idle" ? dict.activity.idle : dict.activity.noReport;
    }
  })();

  // A line that reports an action is worded as the conversation's "Working"
  // block words it: the verb (as it goes on, or once done) and what it acted on.
  const actionText = (action: NonNullable<(typeof lines)[number]["action"]>): string => {
    const steps = chatWork.steps;
    const verb = action.verb === "think" ? (action.running ? dict.activity.thinking : dict.activity.thought) : action.running ? steps[action.verb].ing : steps[action.verb].past;
    return action.target ? `${verb} ${action.target}` : verb;
  };

  return (
    <div
      data-agent-id={agent.agentId}
      data-state={agent.state}
      className={cn("sala-node", status.tone, main && "main", selected && "sel", props.boot && `boot-${props.boot}`, props.delegating && "delegating")}
      style={{ transform: `translate(${String(x)}px, ${String(y)}px)`, width: w, height: h }}
      onPointerDown={(event) => props.onPointerDown(agent.agentId, event)}
    >
      <div className="sala-node-card">
        <button type="button" className="sala-node-hit" tabIndex={0} onClick={() => props.onSelect(agent.agentId)} aria-label={dict.aria.replace("{title}", title).replace("{status}", dict.status[status.label])} />
        <div className="sala-node-head">
          <span className="sala-state" data-status={status.label} title={dict.status[status.label]}>
            {(status.tone === "run" || status.tone === "start") && <span className="sala-spin" aria-hidden="true" />}
            {status.tone === "wait" && <QuestionIcon size={14} />}
            {status.tone === "done" && <CheckIcon size={13} />}
            {status.tone === "stop" && <span aria-hidden="true" style={{ width: 8, height: 8, background: "currentColor" }} />}
            {(status.tone === "fail" || status.tone === "block") && <CloseIcon size={12} />}
            {status.tone === "idle" && <span aria-hidden="true" className="sala-state-idle" />}
          </span>
          <span className="sala-title" title={agent.titlePending === true ? undefined : title}>
            {agent.titlePending === true ? <TitleSkeleton className="h-[1em] w-2/3" /> : title}
          </span>
        </div>
        <div className="sala-node-body">
          {lines.map((line, i) => (
            <div key={i} className={cn("sala-line", line.tone)}>
              <span className="sala-line-at">{line.at === undefined ? null : line.at === "live" ? <LiveAt since={agent.startedAt ?? observedSince} /> : formatClock(line.at)}</span>
              <span className="sala-line-text">{line.action ? actionText(line.action) : (line.text ?? activityText)}</span>
            </div>
          ))}
        </div>
        <div className="sala-strip">
          <AgentLogo agentId={agent.runtime} className="sala-logo" />
          <span className="sala-model">
            {modelLabel}
            {main && <span className="sala-role"> · {dict.main}</span>}
          </span>
          {status.tone === "wait" ? (
            <button type="button" className={cn("sala-reply", props.answering && "on")} data-nodrag aria-expanded={props.answering} onClick={() => props.onReply(agent.agentId)}>
              {dict.reply}
            </button>
          ) : (
            <span className="sala-strip-clock">
              <Clock clock={clock} />
            </span>
          )}
        </div>
      </div>
      {hasParent && <span className="sala-port top" aria-hidden="true" />}
      {hasKids && <span className="sala-port bot" aria-hidden="true" />}
      {bar && (
        <div className={cn("sala-bar", bar === "closing" && "out")} data-nodrag role="toolbar" aria-label={dict.actions.label} inert={bar === "closing"}>
          <button type="button" onClick={() => props.onOpen(agent.agentId)}>
            <ConversationGlyph size={13} />
            <span>{dict.actions.open}</span>
          </button>
          {agent.state !== "stopped" && (
            <button type="button" onClick={() => props.onDelegate(agent.agentId)}>
              <span aria-hidden="true" className="sala-plus">
                +
              </span>
              <span>{dict.actions.delegate}</span>
            </button>
          )}
          {props.canGroup && (
            <button type="button" onClick={() => props.onGroup(agent.agentId)}>
              <AreaIcon size={13} />
              <span>{dict.actions.group}</span>
            </button>
          )}
          {props.canStop && (
            <button type="button" onClick={() => props.onStop(agent.agentId)}>
              <span aria-hidden="true" style={{ width: 8, height: 8, background: "currentColor" }} />
              <span>{dict.actions.stop}</span>
            </button>
          )}
          {props.canRemove && (
            <button type="button" onClick={() => props.onRemove(agent.agentId)}>
              <TrashIcon size={13} />
              <span>{dict.actions.remove}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
});
