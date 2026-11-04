import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/sala/agentCard";
import { formatTokens } from "@/lib/sala/roomFigures";
import type { RoomSubtaskView } from "@/lib/relay/roomClient";
import { subtaskTone } from "@/lib/sala/subtasks";
import { CheckIcon, CloseIcon, QuestionIcon } from "@/components/sala/SalaIcons";
import { useSecondTick } from "@/components/sala/useSecondTick";

export interface SalaSubtaskCardProps {
  /** `undefined` for the "+N" card, which stands for the ones that did not fit. */
  subtask?: RoomSubtaskView;
  hidden?: number;
  /** Where it sits, from the top left of its parent's card. */
  x: number;
  y: number;
  w: number;
  h: number;
  parentTitle: string;
  selected: boolean;
  onSelect: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onOpen: (taskId: string | undefined) => void;
  onStop: (taskId: string) => void;
}

/** How long a running subtask has been at it, counting up. */
function Elapsed({ since }: { since: number }) {
  const now = useSecondTick();
  return <>{formatClock(now - since)}</>;
}

/**
 * One native subagent of an agent, drawn under its card as a small window of
 * its own: the state, what it was asked, what it does now (or how it ended),
 * its tokens and its time. It is not an agent: no runtime, no model, no way
 * to talk to it. It sits inside its parent's node, so pressing and dragging
 * it moves the parent, and its stop button is the one thing it does itself.
 */
export const SalaSubtaskCard = memo(function SalaSubtaskCard(props: SalaSubtaskCardProps) {
  const { subtask, x, y, w, h } = props;
  const dict = useDict().sala;
  const text = dict.subtask;
  const style = { left: x, top: y, width: w, height: h };

  if (!subtask) {
    return (
      <div className="sala-sub more" style={style}>
        <div className="sala-node-card">
          <button type="button" className="sala-sub-hit" aria-label={text.moreAria.replace("{count}", String(props.hidden ?? 0))} onClick={() => props.onOpen(undefined)} />
          <span className="sala-sub-more">{text.more.replace("{count}", String(props.hidden ?? 0))}</span>
        </div>
      </div>
    );
  }

  const tone = subtaskTone(subtask);
  const title = subtask.description ?? subtask.subagentType ?? text.untitled;
  const running = subtask.status === "running";
  const statusKey = running ? (subtask.needsYou ? "yourTurn" : "running") : subtask.status === "completed" ? "done" : subtask.status === "failed" ? "failed" : "stopped";
  const line = running ? subtask.activity : subtask.summaryLine;
  const end = subtask.endedAt;
  return (
    <div className={cn("sala-sub", tone, props.selected && "sel")} data-subtask-id={subtask.taskId} style={style}>
      <div className="sala-node-card">
        <button
          type="button"
          className="sala-sub-hit"
          aria-label={text.aria.replace("{title}", title).replace("{status}", dict.card.status[statusKey]).replace("{parent}", props.parentTitle)}
          onClick={(event) => props.onSelect(subtask.taskId, event)}
          onDoubleClick={() => props.onOpen(subtask.taskId)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onOpen(subtask.taskId);
          }}
        />
        <div className="sala-node-head">
          <span className="sala-state" title={dict.card.status[statusKey]}>
            {running && !subtask.needsYou && <span className="sala-spin" aria-hidden="true" />}
            {running && subtask.needsYou && <QuestionIcon size={12} />}
            {subtask.status === "completed" && <CheckIcon size={11} />}
            {subtask.status === "failed" && <CloseIcon size={11} />}
            {subtask.status === "stopped" && <span aria-hidden="true" style={{ width: 7, height: 7, background: "currentColor" }} />}
          </span>
          <span className="sala-title" title={title}>
            {title}
          </span>
          {running && (
            <button type="button" className="sala-sub-stop" data-nodrag aria-label={text.stopAria.replace("{title}", title)} title={text.stop} onClick={() => props.onStop(subtask.taskId)}>
              <i aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="sala-node-body">
          <div className={cn("sala-line", running && "now")}>
            <span className="sala-line-text" style={{ gridColumn: "1 / 3" }}>
              {subtask.needsYou && <span className="sala-sub-badge">{text.needsYou}</span>}
              {line ?? ""}
            </span>
          </div>
          <div className="sala-sub-meta">
            <span>{subtask.totalTokens === undefined ? "" : text.tokens.replace("{count}", formatTokens(subtask.totalTokens))}</span>
            <span>
              {running ? subtask.needsYou ? text.waiting : <Elapsed since={subtask.startedAt} /> : end === undefined ? "" : dict.card.clock[`${subtask.status === "completed" ? "done" : subtask.status === "failed" ? "failed" : "done"}Took`].replace("{time}", formatClock(end - subtask.startedAt))}
            </span>
          </div>
        </div>
      </div>
      <span className="sala-port top" aria-hidden="true" />
    </div>
  );
});
