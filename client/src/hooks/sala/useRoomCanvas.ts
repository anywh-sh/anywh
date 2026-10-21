import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRoomCanvas, RoomRequestError, saveRoomCanvas, type RoomAgent, type RoomCanvas, type RoomCanvasCamera } from "@/lib/relay/roomClient";
import { cardRects, placeAgents, prunePositions, storedArea } from "@/lib/sala/layout";
import type { Camera } from "@/lib/sala/camera";
import type { Profile } from "@/lib/profiles/profiles";

/** How long after the last change the layout is written back. */
const SAVE_DELAY_MS = 700;
/** How long before a write that failed for a reason that may pass is tried again. */
const RETRY_DELAY_MS = 5_000;

export const EMPTY_CANVAS: RoomCanvas = { positions: {}, areas: [], texts: [] };

export interface RoomCanvasState {
  /** `null` while loading; `missing` when the relay has no such room. */
  status: "loading" | "ready" | "missing";
  canvas: RoomCanvas;
  /** Replaces the canvas (positions, areas, text) and schedules the save. */
  update: (next: RoomCanvas) => void;
  /** Notes where the camera is, for the next save; never re-renders. */
  rememberCamera: (camera: Camera) => void;
  saveFailed: boolean;
}

/**
 * The room's layout: loaded once, completed with a place for every agent as
 * they appear, and written back (debounced, whole) when the person changes
 * it. The camera rides along with the layout but is held in a ref — it
 * changes every frame of a pan and must not cost a render.
 */
export function useRoomCanvas(profile: Profile, roomId: string, agents: readonly RoomAgent[], channelReady: boolean): RoomCanvasState {
  const [status, setStatus] = useState<RoomCanvasState["status"]>("loading");
  const [canvas, setCanvas] = useState<RoomCanvas>(EMPTY_CANVAS);
  const [saveFailed, setSaveFailed] = useState(false);
  const canvasRef = useRef(canvas);
  const cameraRef = useRef<RoomCanvasCamera | undefined>(undefined);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const timerRef = useRef<number | undefined>(undefined);
  const dirtyRef = useRef(false);
  /** Nothing is written back before the stored layout has been read: the
   * empty one this starts from would replace it. */
  const loadedRef = useRef(false);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const flush = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    if (!dirtyRef.current || !loadedRef.current) return;
    dirtyRef.current = false;
    const current = canvasRef.current;
    const cards = cardRects(agentsRef.current, current.positions);
    const body: RoomCanvas = {
      ...current,
      positions: prunePositions(current.positions, new Set(agentsRef.current.map((a) => a.agentId))),
      // Stored with the frame they draw, so a client that cannot place the
      // members (an agent not listed yet) still has somewhere to put the area.
      areas: current.areas.map((area) => storedArea(area, cards)),
      ...(cameraRef.current ? { camera: cameraRef.current } : {}),
    };
    saveRoomCanvas(profileRef.current, roomId, body).then(
      () => setSaveFailed(false),
      (error: unknown) => {
        console.error("[anywh] failed to save the room canvas", error);
        setSaveFailed(true);
        // A network or server failure passes; a canvas the relay called
        // malformed would be refused again, and nothing here can fix it.
        if (error instanceof RoomRequestError && error.status < 500) return;
        dirtyRef.current = true;
        timerRef.current = window.setTimeout(flush, RETRY_DELAY_MS);
      },
    );
  }, [roomId]);

  const schedule = useCallback(() => {
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, SAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    function load(): void {
      fetchRoomCanvas(profileRef.current, roomId).then(
        (loaded) => {
          if (cancelled) return;
          if (loaded === null) {
            setStatus("missing");
            return;
          }
          canvasRef.current = loaded;
          cameraRef.current = loaded.camera;
          loadedRef.current = true;
          setCanvas(loaded);
          setStatus("ready");
        },
        (error: unknown) => {
          console.error("[anywh] failed to load the room canvas", error);
          // Keeps trying rather than opening on an empty layout: the first
          // change would save that over the real one.
          if (!cancelled) retry = window.setTimeout(load, 2000);
        },
      );
    }
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      flush();
    };
  }, [roomId, flush]);

  // Every agent gets a place once both the layout and the first snapshot are
  // in; later arrivals (a worker the principal delegated to) get theirs as
  // they show up.
  useEffect(() => {
    if (status !== "ready" || !channelReady) return;
    const placed = placeAgents(agents, canvasRef.current);
    if (placed === canvasRef.current) return;
    canvasRef.current = placed;
    setCanvas(placed);
    schedule();
  }, [status, channelReady, agents, schedule]);

  const update = useCallback(
    (next: RoomCanvas) => {
      // Whatever the person changes by hand ends the automatic layout.
      const marked = next.manual === true ? next : { ...next, manual: true as const };
      canvasRef.current = marked;
      setCanvas(marked);
      schedule();
    },
    [schedule],
  );

  const rememberCamera = useCallback(
    (camera: Camera) => {
      cameraRef.current = { x: camera.x, y: camera.y, zoom: camera.z };
      schedule();
    },
    [schedule],
  );

  return useMemo(() => ({ status, canvas, update, rememberCamera, saveFailed }), [status, canvas, update, rememberCamera, saveFailed]);
}
