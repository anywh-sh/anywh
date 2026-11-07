import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RoomCardActionsContext } from "@/components/chat/roomCardActions";
import { CheckIcon } from "@/components/sala/SalaIcons";
import { AboutRoomPanel } from "@/components/sala/AboutRoomPanel";
import { AgentAnswer } from "@/components/sala/AgentAnswer";
import { AgentPanel } from "@/components/sala/AgentPanel";
import { NewAgentLauncher, type LaunchOutcome } from "@/components/sala/NewAgentLauncher";
import { SalaCanvas, type SalaCanvasHandle } from "@/components/sala/SalaCanvas";
import type { RoomDock, RoomPaneKind } from "@/components/sala/roomDock";
import type { RoomPaneShell } from "@/components/sala/RoomPaneFrame";
import { useRoomWorktrees } from "@/hooks/sala/useRoomWorktrees";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { useRoomCanvas } from "@/hooks/sala/useRoomCanvas";
import { useRoomPanes } from "@/hooks/sala/useRoomPanes";
import { useDict } from "@/i18n";
import { effectiveModel, getModelCatalogs, labelForModel } from "@/lib/composer/modelCatalog";
import {
  addRoomContextFile,
  DiscardNeededError,
  fetchRoomContextCount,
  fetchRoomWorktrees,
  launchRoomAgent,
  removeRoomAgent,
  restoreRoomAgent,
  resumeRoomAgent,
  RoomRequestError,
  stopAgentSubtask,
  stopRoomAgent,
  type LaunchAgentInput,
  type RoomAgent,
} from "@/lib/relay/roomClient";
import { isRoomCompleted } from "@/lib/sala/roomStatus";
import { retainedWorktrees } from "@/lib/sala/roomFigures";
import type { Profile } from "@/lib/profiles/profiles";
import type { Camera } from "@/lib/sala/camera";
import { cn } from "@/lib/utils";
import type { TicketRef, TicketTag } from "@/lib/integrations/model";
import { takeRoomFocus, useRoomFocusRequest } from "@/lib/sala/roomFocus";
import { RoomTicketsContext } from "@/components/sala/roomTickets";

interface RoomPanelProps {
  profile: Profile;
  /** The room's id: its principal's session id. */
  roomId: string;
  /** The principal's title (the room's name) as the channel last said it. */
  onTitle: (title: string, pending: boolean) => void;
  /** Whether any agent of the room is working, for the tab's indicator. */
  onActiveChange: (active: boolean) => void;
  /** Whether the room's channel is up, for the window's connection status. */
  onConnectedChange: (connected: boolean) => void;
  /** The room no longer exists on the relay. */
  onGone: () => void;
  /** Opens one of the room's agents as a tab of its own. */
  onOpenSession: (sessionId: string, title: string | null) => void;
  /** The tab's dock, where the room's panes open; `null` where there is none
   * (compact windows, iOS) and the room keeps a panel of its own. */
  dock: RoomDock | null;
  /** The ticket the tab carries to the principal ("Work on it in a room…"). */
  pendingTicket?: TicketRef | null;
  onClearPendingTicket?: () => void;
  /** Opens a ticket's screen in the dock; `null` where there is no dock. */
  onShowTicket?: ((ticket: TicketTag) => void) | null;
}

/** Esc pressed in the terminal or the file viewer is theirs, not the room's. */
const NOT_THE_ROOMS = '[data-dock-pane="terminal"], [data-dock-pane="files"]';

/**
 * A room's tab: its live state (one channel), its layout (the relay's
 * canvas) and the canvas that draws them. Everything it does to the room
 * goes through the relay and comes back over the channel — it keeps no copy
 * of an agent's state of its own.
 */
export function RoomPanel({ profile, roomId, onTitle, onActiveChange, onConnectedChange, onGone, onOpenSession, dock, pendingTicket = null, onClearPendingTicket, onShowTicket = null }: RoomPanelProps) {
  const dict = useDict().sala;
  const channel = useRoomChannel(profile, roomId);
  const ready = channel.summary !== null;
  const layout = useRoomCanvas(profile, roomId, channel.agents, ready);
  const [contextCount, setContextCount] = useState(0);
  const panes = useRoomPanes(dock);
  // The agent the agent pane shows; none picked yet is the principal. Kept
  // while the pane is closed: the agent button comes back to the last one.
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);
  const openAgent = useCallback(
    (agentId: string) => {
      setFocusedAgentId(agentId);
      panes.open("agent");
    },
    [panes.open],
  );
  // Stable so the chats under the provider don't re-render with the panel.
  const cardActions = useMemo(() => ({ openAgent }), [openAgent]);
  const roomTickets = useMemo(() => ({ profileId: profile.id, openTicket: onShowTicket }), [profile.id, onShowTicket]);
  const [launcher, setLauncher] = useState<{ open: boolean; parentId: string | undefined }>({ open: false, parentId: undefined });
  const canvasHandle = useRef<SalaCanvasHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gone = channel.status === "gone" || layout.status === "missing";
  const goneNotified = useRef(false);

  useEffect(() => {
    if (gone && !goneNotified.current) {
      goneNotified.current = true;
      onGone();
    }
  }, [gone, onGone]);

  // Asked from outside (a ticket's screen): one agent's conversation in the
  // pane and, for a worker, its card in view — once the room is drawn.
  const focusRequest = useRoomFocusRequest(roomId);
  const drawn = ready && layout.status === "ready";
  const openPane = panes.open;
  useEffect(() => {
    if (!focusRequest || !drawn) return;
    takeRoomFocus(roomId, focusRequest);
    const target = focusRequest.agentId === null ? undefined : channel.agents.find((a) => a.agentId === focusRequest.agentId);
    setFocusedAgentId(target?.agentId ?? null);
    openPane("agent");
    // The canvas mounts with this render; it moves on the next frame.
    if (target) requestAnimationFrame(() => canvasHandle.current?.focusAgent(target.agentId));
  }, [focusRequest, drawn, roomId, channel.agents, openPane]);

  const principal = channel.agents.find((a) => a.role === "principal");
  const principalTitle = principal?.title ?? null;
  const principalTitlePending = principal?.titlePending === true;
  useEffect(() => {
    if (principalTitle) onTitle(principalTitle, principalTitlePending);
    // `onTitle` is stable per tab; the title is what moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principalTitle, principalTitlePending]);

  const working = (channel.summary?.counts.working ?? 0) > 0;
  useEffect(() => {
    onActiveChange(working);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  const connected = channel.status === "open";
  useEffect(() => {
    onConnectedChange(connected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const agentCount = channel.agents.length;
  const refreshContext = useCallback(() => {
    fetchRoomContextCount(profile, roomId).then(setContextCount, () => undefined);
  }, [profile, roomId]);
  useEffect(() => {
    if (ready) refreshContext();
  }, [ready, agentCount, refreshContext]);

  const modelLabelOf = useCallback((agent: RoomAgent): string => {
    const catalog = getModelCatalogs()[agent.runtime];
    const model = effectiveModel(catalog, agent.model);
    return model === null ? agent.runtime : labelForModel(catalog, model);
  }, []);

  const camera = useMemo(() => layout.rememberCamera, [layout.rememberCamera]);
  const onCameraSettled = useCallback((cam: Camera) => camera(cam), [camera]);

  const onStopAgent = useCallback(
    (agentId: string) =>
      stopRoomAgent(profile, roomId, agentId).then(
        () => true,
        (error: unknown) => {
          console.error("[anywh] failed to stop a room agent", error);
          return false;
        },
      ),
    [profile, roomId],
  );
  const onStopSubtask = useCallback(
    (agentId: string, taskId: string) => {
      stopAgentSubtask(profile, roomId, agentId, taskId).catch((error: unknown) => console.error("[anywh] failed to stop a subtask", error));
    },
    [profile, roomId],
  );
  const onSelectSubtask = useCallback((agentId: string, taskId: string) => canvasHandle.current?.selectSubtask(agentId, taskId), []);
  const onRemoveAgent = useCallback(
    (agentId: string, discard: boolean) =>
      removeRoomAgent(profile, roomId, agentId, { discard }).then(
        (result) => ({ undoMs: result.undoMs }),
        (error: unknown) => {
          if (error instanceof DiscardNeededError) return { needsDiscard: error.worktrees };
          console.error("[anywh] failed to remove a room agent", error);
          return null;
        },
      ),
    [profile, roomId],
  );
  const onRestoreAgent = useCallback(
    (agentId: string) =>
      restoreRoomAgent(profile, roomId, agentId).then(
        () => true,
        (error: unknown) => {
          console.error("[anywh] failed to restore a room agent", error);
          return false;
        },
      ),
    [profile, roomId],
  );
  const onCheckWork = useCallback(
    (agentIds: readonly string[]) =>
      fetchRoomWorktrees(profile, roomId).then(
        (data) => data.worktrees.filter((tree) => agentIds.includes(tree.agentId) && !tree.integrated),
        (error: unknown) => {
          // The question says so; the relay still refuses to drop such work unasked.
          console.error("[anywh] failed to check the agents' work before removing them", error);
          return null;
        },
      ),
    [profile, roomId],
  );
  const onResumeAgent = useCallback(
    (agentId: string) => {
      resumeRoomAgent(profile, roomId, agentId).catch((error: unknown) => console.error("[anywh] failed to resume a room agent", error));
    },
    [profile, roomId],
  );
  const onLaunch = useCallback(
    async (input: LaunchAgentInput): Promise<LaunchOutcome> => {
      try {
        await launchRoomAgent(profile, roomId, input);
        return { ok: true };
      } catch (error) {
        console.error("[anywh] failed to start a room agent", error);
        return { ok: false, reason: error instanceof RoomRequestError && error.status === 409 ? "full" : "failed" };
      }
    },
    [profile, roomId],
  );
  const onAttachFiles = useCallback(
    async (files: File[]) => {
      try {
        for (const file of files) await addRoomContextFile(profile, roomId, file);
        return true;
      } catch (error) {
        console.error("[anywh] failed to add a file to the room's context", error);
        return false;
      } finally {
        refreshContext();
      }
    },
    [profile, roomId, refreshContext],
  );

  const principalId = channel.agents.find((a) => a.role === "principal")?.agentId;
  const panelAgent = panes.agentOpen ? (channel.agents.find((a) => a.agentId === (focusedAgentId ?? principalId)) ?? channel.agents.find((a) => a.agentId === principalId)) : undefined;
  const refreshKey = channel.agents.map((a) => `${a.agentId}:${String(a.report?.at ?? 0)}`).join("|");
  const completed = isRoomCompleted(channel.agents);
  const worktrees = useRoomWorktrees(profile, roomId, refreshKey, completed || panelAgent !== undefined);
  const kept = retainedWorktrees(worktrees.data.worktrees).length;

  // The agent the pane showed is gone (removed): the pane stays, on the principal.
  const focusedGone = focusedAgentId !== null && ready && !channel.agents.some((a) => a.agentId === focusedAgentId);
  useEffect(() => {
    if (focusedGone) setFocusedAgentId(null);
  }, [focusedGone]);

  // Esc closes the pane opened last from anywhere on a visible room: whatever
  // has its own use for the key (a menu, a dialog, the launcher) stops it
  // first, and so does the terminal or the file viewer beside the pane.
  const lastPane = panes.last;
  const closePane = panes.close;
  useEffect(() => {
    if (lastPane === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((rootRef.current?.getClientRects().length ?? 0) === 0) return;
      if (event.target instanceof Element && event.target.closest(NOT_THE_ROOMS)) return;
      closePane(lastPane);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lastPane, closePane]);

  // The tab's dock sits beside the room whatever the room is showing: a room
  // still loading, or gone, has the terminal and the files like any other tab.
  const withDock = (room: ReactNode, panesContent: Partial<Record<RoomPaneKind, ReactNode>> = {}): ReactNode => {
    if (!dock) return room;
    return (
      <RoomCardActionsContext.Provider value={cardActions}>
        <RoomTicketsContext.Provider value={roomTickets}>
        <div className="relative flex h-full min-w-0">
          {/* Out of the flow, not shrunk, while a pane is maximized: the canvas keeps its size. */}
          <div className={cn("min-w-0 flex-1", dock.maximized !== null && "invisible absolute inset-0")}>{room}</div>
          {dock.render(panesContent)}
        </div>
        </RoomTicketsContext.Provider>
      </RoomCardActionsContext.Provider>
    );
  };

  if (gone) {
    return withDock(<div className="flex h-full items-center justify-center px-6 text-center font-mono text-[13px] text-text-faint">{dict.canvas.gone}</div>);
  }
  // Until the first snapshot there is nothing to draw but an empty room, and
  // an empty room is a claim ("no agents") this screen cannot make yet.
  if (layout.status !== "ready" || !ready) {
    return withDock(<div className="flex h-full items-center justify-center font-mono text-[13px] text-text-faint">{dict.canvas.loading}</div>);
  }

  const shellOf = (kind: RoomPaneKind): RoomPaneShell =>
    dock ? { kind: "dock", maximized: dock.maximized === kind, onToggleMaximized: () => dock.toggleMaximized(kind) } : { kind: "side" };

  const openLauncher = (parentId?: string): void => {
    setLauncher((current) => (current.open && parentId === undefined ? { open: false, parentId: undefined } : { open: true, parentId: parentId ?? principalId }));
  };

  const aboutPane = panes.aboutOpen && (
    <AboutRoomPanel
      profile={profile}
      roomId={roomId}
      title={principalTitle ?? dict.card.untitled}
      titlePending={principalTitlePending}
      agents={channel.agents}
      tickets={channel.summary?.tickets ?? []}
      onShowTicket={onShowTicket ?? undefined}
      refreshKey={refreshKey}
      shell={shellOf("about")}
      onClose={() => panes.close("about")}
    />
  );
  const agentPane = panelAgent && (
    <AgentPanel
      key={panelAgent.agentId}
      profile={profile}
      roomId={roomId}
      agent={panelAgent}
      parent={channel.agents.find((a) => a.agentId === panelAgent.parentId && a.role === "worker")}
      modelLabel={modelLabelOf(panelAgent)}
      observedSince={channel.since.get(panelAgent.agentId)?.since ?? 0}
      worktrees={worktrees.data.worktrees}
      shell={shellOf("agent")}
      onSelectSubtask={(taskId) => onSelectSubtask(panelAgent.agentId, taskId)}
      onClose={() => panes.close("agent")}
      onOpenInTab={(agentId) => onOpenSession(agentId, channel.agents.find((a) => a.agentId === agentId)?.title ?? null)}
      onDelegate={(agentId) => openLauncher(agentId)}
      onStop={(agentId) => void onStopAgent(agentId)}
      onResume={onResumeAgent}
      onRemove={(agentId) => canvasHandle.current?.removeAgent(agentId)}
      pendingTicket={pendingTicket}
      onClearPendingTicket={onClearPendingTicket}
      onShowTicket={onShowTicket ?? undefined}
    />
  );

  const room = (
    <div ref={rootRef} className="flex h-[calc(100%-1px)] min-w-0 bg-background" data-room-id={roomId}>
      <div className="relative h-full min-w-0 flex-1">
        <SalaCanvas
          handleRef={canvasHandle}
          agents={channel.agents}
          since={channel.since}
          canvas={layout.canvas}
          modelLabelOf={modelLabelOf}
          reconnecting={channel.status === "reconnecting"}
          saveFailed={layout.saveFailed}
          onCanvasChange={layout.update}
          onCameraSettled={onCameraSettled}
          onStopAgent={onStopAgent}
          onRemoveAgent={onRemoveAgent}
          onRestoreAgent={onRestoreAgent}
          onCheckWork={onCheckWork}
          onAttachFiles={onAttachFiles}
          onOpenAgent={openAgent}
          onStopSubtask={onStopSubtask}
          onNewAgent={openLauncher}
          newAgentOpen={launcher.open}
          launcher={
            launcher.open && (
              <NewAgentLauncher
                profile={profile}
                agents={channel.agents}
                parentId={launcher.parentId ?? principalId ?? roomId}
                contextCount={contextCount}
                onParent={(parentId) => setLauncher({ open: true, parentId })}
                onLaunch={onLaunch}
                onClose={() => setLauncher({ open: false, parentId: undefined })}
              />
            )
          }
          onAbout={() => panes.toggle("about")}
          // With a dock the rail has the room's button; without one this is the only way to it.
          aboutVisible={!dock && panes.last === null}
          renderAnswer={(agent, close) => <AgentAnswer profile={profile} agent={agent} onClose={close} onOpenConversation={() => openAgent(agent.agentId)} />}
          onEscape={() => {
            if (panes.last !== null) panes.close(panes.last);
          }}
          onSelectMany={() => {
            panes.closeAll();
            setLauncher({ open: false, parentId: undefined });
          }}
        />
        {completed && (
          <div className="sala-float sala-done" data-float role="status">
            <CheckIcon size={12} />
            <b>{dict.completed.title}</b>
            {kept > 0 && <span>{kept === 1 ? dict.completed.keptOne : dict.completed.kept.replace("{count}", String(kept))}</span>}
            <button type="button" onClick={() => panes.open("about")}>
              {dict.completed.review}
            </button>
          </div>
        )}
      </div>
      {!dock && aboutPane}
      {!dock && agentPane}
    </div>
  );
  if (dock) return withDock(room, { about: aboutPane || undefined, agent: agentPane || undefined });
  return (
    <RoomCardActionsContext.Provider value={cardActions}>
      <RoomTicketsContext.Provider value={roomTickets}>{room}</RoomTicketsContext.Provider>
    </RoomCardActionsContext.Provider>
  );
}
