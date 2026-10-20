import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SalaCanvas } from "@/components/sala/SalaCanvas";
import { useRoomChannel } from "@/hooks/sala/useRoomChannel";
import { useRoomCanvas } from "@/hooks/sala/useRoomCanvas";
import { useDict } from "@/i18n";
import { effectiveModel, getModelCatalogs, labelForModel } from "@/lib/composer/modelCatalog";
import { addRoomContextFile, fetchRoomContextCount, removeRoomAgent, restoreRoomAgent, stopRoomAgent, type RoomAgent } from "@/lib/relay/roomClient";
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
}

/**
 * A room's tab: its live state (one channel), its layout (the relay's
 * canvas) and the canvas that draws them. Everything it does to the room
 * goes through the relay and comes back over the channel — it keeps no copy
 * of an agent's state of its own.
 */
export function RoomPanel({ profile, roomId, onTitle, onActiveChange, onConnectedChange, onGone }: RoomPanelProps) {
  const dict = useDict().sala;
  const channel = useRoomChannel(profile, roomId);
  const ready = channel.summary !== null;
  const layout = useRoomCanvas(profile, roomId, channel.agents, ready);
  const [contextCount, setContextCount] = useState(0);
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
    (agentId: string) =>
      removeRoomAgent(profile, roomId, agentId).then(
        (result) => ({ undoMs: result.undoMs }),
        (error: unknown) => {
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

  if (gone) {
    return <div className="flex h-full items-center justify-center px-6 text-center font-mono text-[13px] text-text-faint">{dict.canvas.gone}</div>;
  }
  // Until the first snapshot there is nothing to draw but an empty room, and
  // an empty room is a claim ("no agents") this screen cannot make yet.
  if (layout.status !== "ready" || !ready) {
    return <div className="flex h-full items-center justify-center font-mono text-[13px] text-text-faint">{dict.canvas.loading}</div>;
  }

  return (
    <div className="relative h-full min-w-0 bg-background" data-room-id={roomId}>
      <SalaCanvas
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
      />
    </div>
  );
}
