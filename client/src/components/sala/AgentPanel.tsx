import { useState } from "react";
import { ArrowUp, GitBranch, Layers } from "lucide-react";
import { ChatPanel, type EmbeddedComposerSession } from "@/components/chat/ChatPanel";
import { PermissionModeButton } from "@/components/chat/PermissionModeButton";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { ConnectorLogo } from "@/components/sala/ConnectorLogo";
import { Clock } from "@/components/sala/SalaCard";
import { CheckIcon, CloseIcon, TrashIcon } from "@/components/sala/SalaIcons";
import { SalaSidePanel } from "@/components/sala/SalaSidePanel";
import { useAgentSubtasks } from "@/hooks/sala/useAgentSubtasks";
import { useDict } from "@/i18n";
import type { Dictionary } from "@/i18n/dictionary";
import { stopAgentSubtask, type RoomAgent, type RoomWorktree } from "@/lib/relay/roomClient";
import { cardClock, cardStatus } from "@/lib/sala/agentCard";
import { connectorLabel } from "@/lib/sala/connectorMarks";
import { agentWork, formatBytes, formatTokens, windowPercent, type AgentWork } from "@/lib/sala/roomFigures";
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
 * One agent of the room in the side panel. Every agent's panel is its whole
 * conversation (the same chat a session tab shows); a worker's adds what the
 * person can do about it around that chat: who delegated it and the worktree
 * it works in, its connectors and subtasks, a compact message box, and
 * stopping or removing it.
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
  const status = cardStatus(agent, 0);
  const clock = cardClock(agent, observedSince, 0);
  const { subtasks, reload } = useAgentSubtasks(profile, roomId, agent.agentId, agent.subtasksRunning);
  const work = agentWork(worktrees, agent.agentId);
  const canStop = agent.state !== "stopped" && agent.state !== "done";
  const stopped = agent.state === "stopped";
  const delegatedBy = text.delegatedBy.replace("{title}", parent ? (parent.title ?? dict.sala.card.untitled) : dict.sala.orchestrator);

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

  // What the conversation does not say: the connectors it was given, its
  // subtasks (with a way to stop one) and that a stopped agent keeps its work.
  const extras = agent.connectors.length > 0 || subtasks.length > 0 || stopped;

  return (
    <SalaSidePanel mark={<Tile runtime={agent.runtime} />} title={title} titlePending={agent.titlePending} subtitle={subtitle} kind="agent" footer={footer} onClose={onClose}>
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

      <div className={cn("sala-side-by", agent.needsYou.length > 0 && "wait")}>
        <span className="trunc" title={delegatedBy}>
          {delegatedBy}
        </span>
        {work.length > 0 && <WorktreeMark work={work} text={text} />}
      </div>

      {status.tone === "fail" && (
        <div className="sala-side-note fail" role="status">
          <b>{text.failedTitle}</b>
          <span>{text.failedBody}</span>
        </div>
      )}

      {extras && (
        <div className="sala-side-extra scrollbar-thin">
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
      )}

      {/* The agent's whole conversation, as a tab shows it: its history, tool
       * calls and thinking, the turn as it streams and the question it asks.
       * Only the box under it is the room's own. */}
      <div className="sala-side-chat flush">
        <ChatPanel key={agent.agentId} profile={profile} sessionId={agent.agentId} isActiveTab={false} renderComposer={(session) => <WorkerComposer session={session} text={text} />} />
      </div>
    </SalaSidePanel>
  );
}

/**
 * The worktree the agent works in, at the end of the "Delegated by" line: its
 * branch (cut short, whole in the tooltip with its commits and whether it was
 * integrated), and a count when the agent made more than one.
 */
function WorktreeMark({ work, text }: { work: AgentWork[]; text: Dictionary["sala"]["panel"]["agent"] }) {
  const [first] = work;
  const describe = (w: AgentWork): string =>
    [
      w.branch,
      w.commits === undefined ? null : w.commits === 1 ? text.commitsOne : text.commits.replace("{count}", String(w.commits)),
      w.integrated ? text.integrated : text.notIntegrated,
      w.sizeBytes === undefined ? null : text.worktreeSize.replace("{size}", formatBytes(w.sizeBytes)),
    ]
      .filter((part) => part !== null)
      .join(" · ");
  return (
    <span className="sala-side-wt" title={work.map(describe).join("\n")} aria-label={text.worktree.replace("{branch}", first.branch)}>
      <GitBranch size={12} aria-hidden="true" />
      <span className="trunc">{first.branch}</span>
      {work.length > 1 && <span className="dim">+{work.length - 1}</span>}
    </span>
  );
}

/**
 * The room's compact box under a worker's conversation: a plain field, the
 * permission mode and send. It sends through the
 * conversation's own session, so the message shows in the log at once.
 */
function WorkerComposer({ session, text }: { session: EmbeddedComposerSession; text: Dictionary["sala"]["panel"]["agent"] }) {
  const [message, setMessage] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const percent = session.contextUsage ? windowPercent(session.contextUsage) : null;
  const contextFigure = session.contextUsage
    ? (percent === null ? text.contextUsedNoWindow : text.contextUsed).replace("{tokens}", formatTokens(session.contextUsage.usedTokens)).replace("{percent}", String(percent))
    : null;

  function send(): void {
    const value = message.trim();
    if (value === "" || !session.connected) return;
    try {
      session.send(value);
      setMessage("");
      setSendFailed(false);
    } catch (error) {
      console.error("[anywh] failed to message a room agent", error);
      setSendFailed(true);
    }
  }

  return (
    <div className="sala-side-compose">
      <textarea
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
        {sendFailed ? <span className="sala-side-err">{text.sendFailed}</span> : contextFigure !== null && <span className="sala-side-clock trunc">{contextFigure}</span>}
        <button type="button" className="sala-send" onClick={send} disabled={message.trim() === "" || !session.connected} aria-label={text.send} title={text.send}>
          <ArrowUp size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
