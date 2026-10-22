import { GitBranch, Layers } from "lucide-react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { ConnectorLogo } from "@/components/sala/ConnectorLogo";
import { Clock } from "@/components/sala/SalaCard";
import { CheckIcon, CloseIcon, TrashIcon } from "@/components/sala/SalaIcons";
import { SalaSidePanel } from "@/components/sala/SalaSidePanel";
import { useAgentSubtasks } from "@/hooks/sala/useAgentSubtasks";
import { useDict } from "@/i18n";
import { stopAgentSubtask, type RoomAgent, type RoomWorktree } from "@/lib/relay/roomClient";
import { cardClock, cardStatus } from "@/lib/sala/agentCard";
import { connectorLabel } from "@/lib/sala/connectorMarks";
import { agentWork, formatBytes } from "@/lib/sala/roomFigures";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/profiles/profiles";

interface AgentPanelProps {
  profile: Profile;
  roomId: string;
  agent: RoomAgent;
  /** Who delegated this agent, when it is not the principal. */
  parent: RoomAgent | undefined;
  modelLabel: string;
  observedSince: number;
  worktrees: readonly RoomWorktree[];
  onClose: () => void;
  onOpenInTab: (agentId: string) => void;
  onDelegate: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onResume: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}

function Tile({ runtime }: { runtime: string }) {
  return <AgentLogo agentId={runtime} className="sala-logo big" />;
}

/**
 * One agent of the room in the side panel. The principal's panel is its whole
 * conversation (the same chat a session tab shows); a worker's is that same
 * chat under a short summary (state, who delegated it, what it produced), with
 * what the person can do about it: open it in a tab, delegate from it, stop or
 * remove it. The chat carries the rest: what it is doing and has done, the
 * question it asked, the message field and its permission mode.
 */
export function AgentPanel(props: AgentPanelProps) {
  const { agent } = props;
  const dict = useDict();
  const text = dict.sala.panel;
  const runtimeName = agentName(dict.chat.composer.agentNames, agent.runtime);
  const title = agent.title ?? dict.sala.card.untitled;
  const subtitle = (agent.role === "principal" ? text.principal.subtitle : text.agent.subtitle).replace("{runtime}", runtimeName).replace("{model}", props.modelLabel);

  if (agent.role === "principal") {
    return (
      <SalaSidePanel mark={<Tile runtime={agent.runtime} />} title={title} titlePending={agent.titlePending} subtitle={subtitle} kind="principal" onClose={props.onClose}>
        <div className="sala-side-chat">
          <ChatPanel key={agent.agentId} profile={props.profile} sessionId={agent.agentId} isActiveTab={false} />
        </div>
      </SalaSidePanel>
    );
  }
  return <WorkerPanel key={agent.agentId} {...props} title={title} subtitle={subtitle} />;
}

function WorkerPanel({ profile, roomId, agent, parent, observedSince, worktrees, title, subtitle, onClose, onOpenInTab, onDelegate, onStop, onResume, onRemove }: AgentPanelProps & { title: string; subtitle: string }) {
  const dict = useDict();
  const text = dict.sala.panel.agent;
  const status = cardStatus(agent, 0);
  const clock = cardClock(agent, observedSince, 0);
  const { subtasks, reload } = useAgentSubtasks(profile, roomId, agent.agentId, agent.subtasksRunning);
  const work = agentWork(worktrees, agent.agentId);
  const canStop = agent.state !== "stopped" && agent.state !== "done";
  const stopped = agent.state === "stopped";

  const footer = (
    <>
      <button type="button" className="sala-side-act" onClick={() => onOpenInTab(agent.agentId)}>
        <Layers size={13} aria-hidden="true" />
        <span>{text.openInTab}</span>
      </button>
      <button type="button" className="sala-side-act" onClick={() => onDelegate(agent.agentId)}>
        <span aria-hidden="true">+</span>
        <span>{text.delegate}</span>
      </button>
      <span className="grow" />
      {stopped ? (
        <button type="button" className="sala-side-act" onClick={() => onResume(agent.agentId)}>
          <span>{text.resume}</span>
        </button>
      ) : (
        canStop && (
          <button type="button" className="sala-side-act" onClick={() => onStop(agent.agentId)}>
            <span aria-hidden="true" style={{ width: 8, height: 8, background: "currentColor" }} />
            <span>{text.stop}</span>
          </button>
        )
      )}
      <button type="button" className="sala-side-act" onClick={() => onRemove(agent.agentId)}>
        <TrashIcon size={13} />
        <span>{text.remove}</span>
      </button>
    </>
  );

  return (
    <SalaSidePanel mark={<Tile runtime={agent.runtime} />} title={title} titlePending={agent.titlePending} subtitle={subtitle} kind="agent" footer={footer} onClose={onClose}>
      <div className="sala-side-summary">
        <div className="sala-side-status">
          <span className={cn("sala-side-state", status.tone)}>
            {(status.tone === "run" || status.tone === "start") && <span className="sala-spin" aria-hidden="true" />}
            {status.tone === "wait" && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
            {status.tone === "done" && <CheckIcon size={11} />}
            {status.tone === "stop" && <span aria-hidden="true" style={{ width: 7, height: 7, background: "currentColor" }} />}
            {(status.tone === "fail" || status.tone === "block") && <CloseIcon size={10} />}
            <span>{dict.sala.card.status[status.label]}</span>
          </span>
          <span className="sala-side-clock">
            <Clock clock={clock} />
          </span>
        </div>

        <div className={cn("sala-side-by", agent.needsYou.length > 0 && "wait")}>{text.delegatedBy.replace("{title}", parent ? (parent.title ?? dict.sala.card.untitled) : text.principal)}</div>

        {status.tone === "fail" && (
          <div className="sala-side-note fail" role="status">
            <b>{text.failedTitle}</b>
            <span>{text.failedBody}</span>
          </div>
        )}

      </div>
      <details className="sala-side-details">
        <summary>{text.details}</summary>
        <div className="sala-side-pad scrollbar-thin">
          {agent.report && agent.report.summary !== "" && (
            <section className="sala-side-sec">
              <h3 className="sala-side-h">{text.report}</h3>
              <p className="sala-side-report">{agent.report.summary}</p>
              {agent.report.artifacts.length > 0 && (
                <ul className="sala-side-files">
                  {agent.report.artifacts.map((path) => (
                    <li key={path} className="mono">
                      {path}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="sala-side-sec">
            <h3 className="sala-side-h">{text.work}</h3>
            {work.length === 0 && <p className="sala-side-empty">{text.noWork}</p>}
            {work.map((w) => (
              <div key={w.branch} className="sala-side-row wt">
                <GitBranch size={14} aria-hidden="true" />
                <span className="grow trunc mono" title={w.branch}>
                  {w.branch}
                </span>
                <span className="mono dim">
                  {w.commits === undefined ? "" : w.commits === 1 ? text.commitsOne : text.commits.replace("{count}", String(w.commits))}
                </span>
                <span className={w.integrated ? "mono ok" : "mono warn"}>{w.integrated ? text.integrated : text.notIntegrated}</span>
                {w.sizeBytes !== undefined && <span className="mono dim">{text.worktreeSize.replace("{size}", formatBytes(w.sizeBytes))}</span>}
              </div>
            ))}
          </section>

          {agent.connectors.length > 0 && (
            <section className="sala-side-sec">
              <h3 className="sala-side-h">{text.connectors}</h3>
              <div className="sala-chips">
                {agent.connectors.map((server) => (
                  <span key={server} className="sala-chip">
                    <ConnectorLogo server={server} className="size-3" />
                    {connectorLabel(server)}
                  </span>
                ))}
              </div>
            </section>
          )}

          {subtasks.length > 0 && (
            <section className="sala-side-sec">
              <h3 className="sala-side-h">{text.subtasks}</h3>
              {subtasks.map((task) => (
                <div key={task.taskId} className="sala-side-row">
                  <span className={cn("sala-sub-dot", task.status)} aria-hidden="true" />
                  <span className="grow trunc" title={task.activity ?? task.summary}>
                    {task.description ?? task.subagentType ?? task.taskId}
                  </span>
                  {task.status === "running" && (
                    <button
                      type="button"
                      className="sala-mini"
                      onClick={() => {
                        stopAgentSubtask(profile, roomId, agent.agentId, task.taskId).then(reload, (error: unknown) => console.error("[anywh] failed to stop a subtask", error));
                      }}
                    >
                      {text.subtaskStop}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {stopped && (
            <p className="sala-side-fine">
              {text.stoppedTitle} · {text.removedWork}
            </p>
          )}
        </div>
      </details>
      <div className="sala-side-chat">
        <ChatPanel key={agent.agentId} profile={profile} sessionId={agent.agentId} isActiveTab={false} />
      </div>
    </SalaSidePanel>
  );
}
