import { useEffect, useRef, useState } from "react";
import { ArrowUp, GitBranch, Layers } from "lucide-react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ChoiceCard } from "@/components/chat/ChoiceCard";
import { PermissionModeButton } from "@/components/chat/PermissionModeButton";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { ConnectorLogo } from "@/components/sala/ConnectorLogo";
import { Clock } from "@/components/sala/SalaCard";
import { CheckIcon, CloseIcon, TrashIcon } from "@/components/sala/SalaIcons";
import { SalaSidePanel } from "@/components/sala/SalaSidePanel";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { useAgentReply } from "@/hooks/sala/useAgentReply";
import { useAgentSubtasks } from "@/hooks/sala/useAgentSubtasks";
import { useRelayClient } from "@/hooks/relay/useRelayClient";
import { useDict } from "@/i18n";
import { stopAgentSubtask, type RoomAgent, type RoomWorktree } from "@/lib/relay/roomClient";
import { shouldShowReply } from "@/lib/sala/agentReply";
import { cardClock, cardStatus } from "@/lib/sala/agentCard";
import { connectorLabel } from "@/lib/sala/connectorMarks";
import { agentWork, formatBytes, formatTokens, windowPercent } from "@/lib/sala/roomFigures";
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
 * conversation (the same chat a session tab shows); a worker's is a summary
 * with what the person can do about it: answer what it asked, message it,
 * change its permission mode, stop or remove it.
 */
export function AgentPanel(props: AgentPanelProps) {
  const { agent } = props;
  const dict = useDict();
  const text = dict.sala.panel;
  const runtimeName = agentName(dict.chat.composer.agentNames, agent.runtime);
  const subtitle = text.agent.subtitle.replace("{runtime}", runtimeName).replace("{model}", props.modelLabel);

  if (agent.role === "principal") {
    // A fixed name, never a placeholder: the generated title is the room's.
    return (
      <SalaSidePanel mark={<Tile runtime={agent.runtime} />} title={dict.sala.orchestrator} subtitle={subtitle} kind="principal" onClose={props.onClose}>
        <div className="sala-side-chat">
          <ChatPanel key={agent.agentId} profile={props.profile} sessionId={agent.agentId} isActiveTab={false} />
        </div>
      </SalaSidePanel>
    );
  }
  return <WorkerPanel key={agent.agentId} {...props} title={agent.title ?? dict.sala.card.untitled} subtitle={subtitle} />;
}

function WorkerPanel({ profile, roomId, agent, parent, observedSince, worktrees, title, subtitle, onClose, onOpenInTab, onDelegate, onStop, onResume, onRemove }: AgentPanelProps & { title: string; subtitle: string }) {
  const dict = useDict();
  const text = dict.sala.panel.agent;
  // The panel's one connection to the worker's session. Its replies are read off
  // the same socket (what the agent last said is not the principal's chat).
  const { reply, handlers } = useAgentReply();
  const session = useRelayClient(profile, agent.agentId, handlers);
  const status = cardStatus(agent, 0);
  const percent = session.contextUsage ? windowPercent(session.contextUsage) : null;
  const contextFigure = session.contextUsage
    ? (percent === null ? text.contextUsedNoWindow : text.contextUsed).replace("{tokens}", formatTokens(session.contextUsage.usedTokens)).replace("{percent}", String(percent))
    : null;
  const clock = cardClock(agent, observedSince, 0);
  const { subtasks, reload } = useAgentSubtasks(profile, roomId, agent.agentId, agent.subtasksRunning);
  const work = agentWork(worktrees, agent.agentId);
  const [message, setMessage] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const canStop = agent.state !== "stopped" && agent.state !== "done";
  const stopped = agent.state === "stopped";

  // A different agent starts with an empty box.
  useEffect(() => {
    setMessage("");
    setSendFailed(false);
  }, [agent.agentId]);

  function send(): void {
    const value = message.trim();
    if (value === "" || !session.connected) return;
    try {
      session.sendMessage(value);
      setMessage("");
      setSendFailed(false);
    } catch (error) {
      console.error("[anywh] failed to message a room agent", error);
      setSendFailed(true);
    }
  }

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
      <div className="sala-side-body flush scrollbar-thin">
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
            {contextFigure !== null && `${contextFigure} · `}
            <Clock clock={clock} />
          </span>
        </div>

        <div className={cn("sala-side-by", agent.needsYou.length > 0 && "wait")}>{text.delegatedBy.replace("{title}", parent ? (parent.title ?? dict.sala.card.untitled) : dict.sala.orchestrator)}</div>

        {agent.needsYou.length > 0 && (
          <div className="sala-side-q">
            {session.choicePrompt ? (
              <ChoiceCard key={session.choicePrompt.promptId} promptId={session.choicePrompt.promptId} questions={session.choicePrompt.questions} kind={session.choicePrompt.kind} onAnswer={(answers) => session.answerChoice(answers)} />
            ) : (
              <p className="sala-side-empty pad">{text.connecting}</p>
            )}
          </div>
        )}

        {status.tone === "fail" && (
          <div className="sala-side-note fail" role="status">
            <b>{text.failedTitle}</b>
            <span>{text.failedBody}</span>
          </div>
        )}

        <div className="sala-side-pad">
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
      </div>

      {shouldShowReply(reply, (agent.report?.summary ?? "") !== "") && (
        <div className="sala-side-reply">
          <h3 className="sala-side-h">
            {text.reply}
            {reply.running && <span className="sala-side-working"> · {text.working}</span>}
          </h3>
          {reply.text !== "" && (
            <div className="sala-side-reply-body scrollbar-thin">
              <div className="prose-chat text-[13px] text-foreground">
                <MarkdownContent text={reply.text} />
              </div>
            </div>
          )}
          {reply.error !== null && (
            <p className="sala-side-err" role="status">
              {reply.error}
            </p>
          )}
        </div>
      )}
      <div className="sala-side-compose">
        <textarea
          ref={boxRef}
          className="sala-side-box scrollbar-thin"
          value={message}
          placeholder={text.messagePlaceholder}
          aria-label={text.messagePlaceholder}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="sala-side-compose-bar">
          {session.permissionMode !== null && <PermissionModeButton mode={session.permissionMode} available={session.permissionModes} onChange={session.setPermissionMode} />}
          <span className="grow" />
          {sendFailed && <span className="sala-side-err">{text.sendFailed}</span>}
          <button type="button" className="sala-send" onClick={send} disabled={message.trim() === "" || !session.connected} aria-label={text.send} title={text.send}>
            <ArrowUp size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </SalaSidePanel>
  );
}
