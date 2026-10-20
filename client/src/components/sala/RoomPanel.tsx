import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "@/components/sala/SalaIcons";
import { AboutRoomPanel } from "@/components/sala/AboutRoomPanel";
import { AgentAnswer } from "@/components/sala/AgentAnswer";
import { AgentPanel } from "@/components/sala/AgentPanel";
import { NewAgentLauncher, type LaunchOutcome } from "@/components/sala/NewAgentLauncher";
import { SalaCanvas, type SalaCanvasHandle } from "@/components/sala/SalaCanvas";
import { useRoomWorktrees } from "@/hooks/sala/useRoomWorktrees";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { useRoomCanvas } from "@/hooks/sala/useRoomCanvas";
import { useDict } from "@/i18n";
import { effectiveModel, getModelCatalogs, labelForModel } from "@/lib/composer/modelCatalog";
import {
  addRoomContextFile,
  DiscardNeededError,
  fetchRoomContextCount,
  launchRoomAgent,
  removeRoomAgent,
  restoreRoomAgent,
  resumeRoomAgent,
  RoomRequestError,
  stopRoomAgent,
  type LaunchAgentInput,
  type RoomAgent,
} from "@/lib/relay/roomClient";
import { isRoomCompleted } from "@/lib/sala/roomStatus";
import { retainedWorktrees } from "@/lib/sala/roomFigures";
import type { Profile } from "@/lib/profiles/profiles";
import type { Camera } from "@/lib/sala/camera";

interface RoomPanelProps {
  profile: Profile;
  /** The room's id: its principal's session id. */
  roomId: string;
  /** The principal's title (the room's name) as the channel last said it. */
  onTitle: (title: string) => void;
  /** Whether any agent of the room is working, for the tab's indicator. */
  onActiveChange: (active: boolean) => void;
  /** Whether the room's channel is up, for the window's connection status. */
  onConnectedChange: (connected: boolean) => void;
  /** The room no longer exists on the relay. */
  onGone: () => void;
  /** Opens one of the room's agents as a tab of its own. */
  onOpenSession: (sessionId: string, title: string | null) => void;
}

type PanelState = { kind: "about" } | { kind: "agent"; id: string } | null;

/**
 * A room's tab: its live state (one channel), its layout (the relay's
 * canvas) and the canvas that draws them. Everything it does to the room
 * goes through the relay and comes back over the channel — it keeps no copy
 * of an agent's state of its own.
 */
export function RoomPanel({ profile, roomId, onTitle, onActiveChange, onConnectedChange, onGone, onOpenSession }: RoomPanelProps) {
  const dict = useDict().sala;
  const channel = useRoomChannel(profile, roomId);
  const ready = channel.summary !== null;
  const layout = useRoomCanvas(profile, roomId, channel.agents, ready);
  const [contextCount, setContextCount] = useState(0);
  const [panel, setPanel] = useState<PanelState>(null);
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

  const principalTitle = channel.agents.find((a) => a.role === "principal")?.title ?? null;
  useEffect(() => {
    if (principalTitle) onTitle(principalTitle);
    // `onTitle` is stable per tab; the title is what moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principalTitle]);

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
  const panelAgent = panel?.kind === "agent" ? channel.agents.find((a) => a.agentId === panel.id) : undefined;
  const refreshKey = channel.agents.map((a) => `${a.agentId}:${String(a.report?.at ?? 0)}`).join("|");
  const completed = isRoomCompleted(channel.agents);
  const worktrees = useRoomWorktrees(profile, roomId, refreshKey, completed || panelAgent !== undefined);
  const kept = retainedWorktrees(worktrees.data.worktrees).length;

  // The agent a panel showed is gone (removed): so is the panel.
  useEffect(() => {
    if (panel?.kind === "agent" && !panelAgent && ready) setPanel(null);
  }, [panel, panelAgent, ready]);

  // Esc closes the panel from anywhere on a visible room: whatever has its own
  // use for the key (a menu, a dialog, the launcher) stops it first.
  const panelOpen = panel !== null;
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((rootRef.current?.getClientRects().length ?? 0) === 0) return;
      setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  if (gone) {
    return <div className="flex h-full items-center justify-center px-6 text-center font-mono text-[13px] text-text-faint">{dict.canvas.gone}</div>;
  }
  // Until the first snapshot there is nothing to draw but an empty room, and
  // an empty room is a claim ("no agents") this screen cannot make yet.
  if (layout.status !== "ready" || !ready) {
    return <div className="flex h-full items-center justify-center font-mono text-[13px] text-text-faint">{dict.canvas.loading}</div>;
  }

  const openLauncher = (parentId?: string): void => {
    setLauncher((current) => (current.open && parentId === undefined ? { open: false, parentId: undefined } : { open: true, parentId: parentId ?? principalId }));
  };

  return (
    <div ref={rootRef} className="flex h-full min-w-0 bg-background" data-room-id={roomId}>
      <div className="relative h-full min-w-0 flex-1">
        <SalaCanvas
          handleRef={canvasHandle}
          agents={channel.agents}
          since={channel.since}
          canvas={layout.canvas}
          contextCount={contextCount}
          modelLabelOf={modelLabelOf}
          reconnecting={channel.status === "reconnecting"}
          saveFailed={layout.saveFailed}
          onCanvasChange={layout.update}
          onCameraSettled={onCameraSettled}
          onStopAgent={onStopAgent}
          onRemoveAgent={onRemoveAgent}
          onRestoreAgent={onRestoreAgent}
          onAttachFiles={onAttachFiles}
          onOpenAgent={(agentId) => setPanel({ kind: "agent", id: agentId })}
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
          onAbout={() => setPanel((current) => (current?.kind === "about" ? null : { kind: "about" }))}
          aboutVisible={panel === null}
          renderAnswer={(agent, close) => <AgentAnswer profile={profile} agent={agent} onClose={close} onOpenConversation={() => setPanel({ kind: "agent", id: agent.agentId })} />}
          onEscape={() => setPanel(null)}
        />
        {completed && (
          <div className="sala-float sala-done" data-float role="status">
            <CheckIcon size={12} />
            <b>{dict.completed.title}</b>
            {kept > 0 && <span>{kept === 1 ? dict.completed.keptOne : dict.completed.kept.replace("{count}", String(kept))}</span>}
            <button type="button" onClick={() => setPanel({ kind: "about" })}>
              {dict.completed.review}
            </button>
          </div>
        )}
      </div>
      {panel?.kind === "about" && (
        <AboutRoomPanel profile={profile} roomId={roomId} title={principalTitle ?? dict.card.untitled} agents={channel.agents} canvas={layout.canvas} refreshKey={refreshKey} onClose={() => setPanel(null)} />
      )}
      {panelAgent && (
        <AgentPanel
          key={panelAgent.agentId}
          profile={profile}
          roomId={roomId}
          agent={panelAgent}
          parent={channel.agents.find((a) => a.agentId === panelAgent.parentId && a.role === "worker")}
          modelLabel={modelLabelOf(panelAgent)}
          observedSince={channel.since.get(panelAgent.agentId)?.since ?? 0}
          worktrees={worktrees.data.worktrees}
          onClose={() => setPanel(null)}
          onOpenInTab={(agentId) => onOpenSession(agentId, channel.agents.find((a) => a.agentId === agentId)?.title ?? null)}
          onDelegate={(agentId) => openLauncher(agentId)}
          onStop={(agentId) => void onStopAgent(agentId)}
          onResume={onResumeAgent}
          onRemove={(agentId) => canvasHandle.current?.removeAgent(agentId)}
        />
      )}
    </div>
  );
}
