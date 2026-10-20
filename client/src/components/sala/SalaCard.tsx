import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import { cardActivity, cardClock, cardStatus, formatClock, progressSegments, PROGRESS_SEGMENTS, runtimeTile, type CardClock } from "@/lib/sala/agentCard";
import type { RoomAgent } from "@/lib/relay/roomClient";
import { CheckIcon, CloseIcon, ConversationGlyph, LayersIcon, AreaIcon, TrashIcon } from "@/components/sala/SalaIcons";
import { useSecondTick } from "@/components/sala/useSecondTick";

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
  contextCount: number;
  /** Workers in the room: what a working principal says it coordinates. */
  workers: number;
  /** Of those, the ones working or about to: what makes a principal that has
   * finished delegating still read as running. */
  liveWorkers: number;
  /** When this screen first saw the agent in its present state. */
  observedSince: number;
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

/**
 * One agent's card. Positioned by `transform` alone (the canvas moves it
 * during a drag by writing that same property), so a card is never laid out
 * again for being moved. Memoized: only the cards whose agent changed
 * render when the channel reports a change.
 */
export const SalaCard = memo(function SalaCard(props: SalaCardProps) {
  const { agent, x, y, w, h, selected, hasParent, hasKids, modelLabel, contextCount, workers, liveWorkers, observedSince } = props;
  const dict = useDict().sala.card;
  const status = cardStatus(agent, liveWorkers);
  const activity = cardActivity(agent, workers, liveWorkers);
  const clock = cardClock(agent, observedSince, liveWorkers);
  const segments = progressSegments(status.tone);
  const title = agent.title ?? dict.untitled;
  const main = agent.role === "principal";
  const showBar = selected;

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

  return (
    <div
      data-agent-id={agent.agentId}
      data-state={agent.state}
      className={cn("sala-node", status.tone, main && "main", selected && "sel")}
      style={{ transform: `translate(${String(x)}px, ${String(y)}px)`, width: w, height: h }}
      onPointerDown={(event) => props.onPointerDown(agent.agentId, event)}
    >
      <div className="sala-node-card">
        <button type="button" className="sala-node-hit" tabIndex={0} onClick={() => props.onSelect(agent.agentId)} aria-label={dict.aria.replace("{title}", title).replace("{status}", dict.status[status.label])} />
        <div className="sala-node-body">
          <div className="sala-node-head">
            <span className="sala-tile" aria-hidden="true">
              {runtimeTile(agent.runtime)}
            </span>
            <span className="sala-model">{modelLabel}</span>
            {main && <span className="sala-role">· {dict.main}</span>}
            <span className={cn("sala-pill", status.tone)} data-status={status.label}>
              {(status.tone === "run" || status.tone === "start") && <span className="sala-spin" aria-hidden="true" />}
              {status.tone === "wait" && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
              {status.tone === "done" && <CheckIcon size={11} />}
              {status.tone === "stop" && <span aria-hidden="true" style={{ width: 7, height: 7, background: "currentColor" }} />}
              {(status.tone === "fail" || status.tone === "block") && <CloseIcon size={10} />}
              <span>{dict.status[status.label]}</span>
            </span>
          </div>
          <div className="sala-title">{title}</div>
          <div className="sala-activity">
            <span>{activityText}</span>
          </div>
          <div className="sala-segs" aria-hidden="true">
            {Array.from({ length: PROGRESS_SEGMENTS }, (_, i) => (
              <span key={i} className={i < segments.lit ? "on" : segments.live && i === 5 ? "live" : undefined} />
            ))}
          </div>
        </div>
        <div className="sala-strip">
          <span className="sala-strip-clock">
            <Clock clock={clock} />
          </span>
          {status.tone === "wait" ? (
            <button type="button" className="sala-reply" data-nodrag onClick={() => props.onReply(agent.agentId)}>
              {dict.reply}
            </button>
          ) : (
            <span className="sala-ctx" title={dict.context.replace("{count}", String(contextCount))}>
              <LayersIcon size={12} />
              <span>{contextCount}</span>
            </span>
          )}
        </div>
      </div>
      {hasParent && <span className="sala-port top" aria-hidden="true" />}
      {hasKids && <span className="sala-port bot" aria-hidden="true" />}
      {showBar && (
        <div className="sala-bar" data-nodrag role="toolbar" aria-label={dict.actions.label}>
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
