import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import "@/components/sala/sala.css";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import type { RoomAgent, RoomAgentState, RoomCanvas, RoomCanvasText, RoomWorktree } from "@/lib/relay/roomClient";
import {
  MINIMAP_H,
  MINIMAP_W,
  boundsOf,
  cameraShows,
  fitCamera,
  gridLayer,
  gridNeedsRedraw,
  layoutZoom,
  minimapMap,
  minimapRect,
  minimapToWorld,
  minimapView,
  nextZoomLevel,
  planeStyle,
  revealCamera,
  screenToWorld,
  snap,
  wheelZoom,
  zoomAround,
  type Camera,
  type MinimapMap,
  type Rect,
} from "@/lib/sala/camera";
import { CameraController, releaseVelocity } from "@/lib/sala/cameraController";
import { cardStatus } from "@/lib/sala/agentCard";
import { AREA_PAD, areaRect, cardRects, edgePath, groupInto, membershipAfterDrop, pathLength, storedArea, subtreeIds, trackDrag, worldBounds } from "@/lib/sala/layout";
import { prefersReducedMotion, useArrivals, useNewAreas } from "@/components/sala/useArrivals";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SalaCard } from "@/components/sala/SalaCard";
import { SalaToolbar, type SalaTool } from "@/components/sala/SalaToolbar";
import { AboutIcon, CloseIcon } from "@/components/sala/SalaIcons";

export interface SalaCanvasProps {
  agents: readonly RoomAgent[];
  since: ReadonlyMap<string, { state: RoomAgentState; since: number }>;
  canvas: RoomCanvas;
  modelLabelOf: (agent: RoomAgent) => string;
  reconnecting: boolean;
  /** The relay refused or could not take the last write of the layout. */
  saveFailed: boolean;
  onCanvasChange: (next: RoomCanvas) => void;
  /** The camera came to rest (or was set): where it is now. */
  onCameraSettled: (camera: Camera) => void;
  onStopAgent: (agentId: string) => Promise<boolean>;
  /** `needsDiscard`: the agent has work nobody integrated and the relay waits
   * for the person to say it may be thrown away. */
  onRemoveAgent: (agentId: string, discard: boolean) => Promise<{ undoMs: number } | { needsDiscard: RoomWorktree[] } | null>;
  onRestoreAgent: (agentId: string) => Promise<boolean>;
  onAttachFiles: (files: File[]) => Promise<boolean>;
  /** "Open conversation" on a card: the room's side panel shows that agent. */
  onOpenAgent: (agentId: string) => void;
  /** "Delegate" on a card, or the toolbar's new agent (`undefined`): the launcher opens. */
  onNewAgent: (parentId?: string) => void;
  newAgentOpen: boolean;
  /** The launcher, drawn over the toolbar while it is open. */
  launcher: ReactNode;
  /** The "i" button: about the room. Hidden while a side panel is open. */
  onAbout: () => void;
  aboutVisible: boolean;
  /** What an agent asked, answerable under its card. */
  renderAnswer: (agent: RoomAgent, close: () => void) => ReactNode;
  /** Esc with nothing left to clear: closes the side panel. */
  onEscape: () => void;
  /** Lets the room's panel remove an agent through the same flow as the card's bar. */
  handleRef?: Ref<SalaCanvasHandle>;
}

export interface SalaCanvasHandle {
  removeAgent: (agentId: string) => void;
}

interface Toast {
  key: number;
  title: string;
  action?: { label: string; run: () => void };
}

type Drag =
  | { kind: "pan"; pointerId: number; sx: number; sy: number; cx: number; cy: number; moved: boolean; samples: [number, number, number][] }
  | { kind: "node"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; el: HTMLElement | null }
  | { kind: "frame"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; input: HTMLInputElement | null; members: { id: string; ox: number; oy: number }[] }
  | { kind: "text"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; off: number; moved: boolean; el: HTMLElement | null; input: HTMLInputElement | null }
  | { kind: "draw"; pointerId: number; sx: number; sy: number; ox: number; oy: number; moved: boolean };

const TEXT_BIG_AT = 0; // the first text is a heading: see `isBigText`
/** What the relay accepts: a longer label or text would be refused, and with it
 * the whole layout. */
const AREA_LABEL_MAX = 200;
const TEXT_MAX = 4000;
const MIN_DRAWN = 48;
const DEFAULT_AREA = { w: 480, h: 312 };

/** Texts on the canvas read as a heading when they are the first one: the
 * relay stores no size, and the design's one title is the room's name. */
function isBigText(texts: readonly RoomCanvasText[], id: string): boolean {
  return texts[TEXT_BIG_AT]?.id === id;
}

/** How far above its `y` a text's box starts: its baseline sits on `y`. */
const textLift = (big: boolean): number => (big ? 42 : 22);

const translate = (x: number, y: number): string => `translate(${String(x)}px, ${String(y)}px)`;

/** How long a dropped card takes to settle on the grid. */
export const DROP_SETTLE_MS = 180;
const easeOutQuart = (t: number): number => 1 - (1 - t) ** 4;

/** Places an area's frame. By `left`/`top`, not a transform: see `.sala-frame`. */
const placeFrame = (el: HTMLElement, rect: Rect): void => {
  el.style.left = `${String(rect.x)}px`;
  el.style.top = `${String(rect.y)}px`;
  el.style.width = `${String(rect.w)}px`;
  el.style.height = `${String(rect.h)}px`;
};

/** The states a link takes the color of (its child's); any other draws the neutral line. */
const linkTone = (tone: string): string | false => (tone === "run" || tone === "start" || tone === "wait" || tone === "done" || tone === "stop") && tone;

let nextId = 0;
const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${String((nextId += 1))}`;

export function SalaCanvas(props: SalaCanvasProps) {
  const dict = useDict().sala;
  const { agents, canvas } = props;
  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const mmViewRef = useRef<HTMLSpanElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<SalaTool>("select");
  const [spaceDown, setSpaceDown] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [measured, setMeasured] = useState(false);
  const drawEl = useRef<HTMLDivElement>(null);

  // What event handlers need, as of the latest render.
  const latest = useRef({ ...props, tool, spaceDown, selected });
  latest.current = { ...props, tool, spaceDown, selected };
  const vpSize = useRef({ w: 0, h: 0 });
  const live = useRef(new Map<string, { x: number; y: number }>());
  const dragRef = useRef<Drag | null>(null);
  const bgZ = useRef(1);
  const bgKey = useRef("");
  const zooming = useRef(false);
  /** The zoom the plane is laid out at (`planeStyle`): held still while a zoom is in flight. */
  const planeZoom = useRef<number | null>(null);
  const initialized = useRef(false);
  /** Set while the camera is put back where it was saved, which saves nothing. */
  const quiet = useRef(false);
  /** The camera keeps the whole room in view as it grows, until the person
   * moves it themselves (or it was restored from where they left it). */
  const follow = useRef(!props.canvas.camera);
  const pendingFocus = useRef<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // ─── what is on the canvas ───
  const rects = useMemo(() => cardRects(agents, canvas.positions), [agents, canvas.positions]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.agentId, a])), [agents]);
  const kids = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of agents) if (a.parentId !== undefined && byId.has(a.parentId)) out.set(a.parentId, (out.get(a.parentId) ?? 0) + 1);
    return out;
  }, [agents, byId]);
  const workers = useMemo(() => agents.filter((a) => a.role === "worker").length, [agents]);
  const liveWorkers = useMemo(() => agents.filter((a) => a.role === "worker" && (a.state === "working" || a.state === "queued")).length, [agents]);
  const frames = useMemo(
    () =>
      canvas.areas.map((area) => {
        const members = (area.members ?? []).flatMap((id) => {
          const agent = byId.get(id);
          return agent && rects.has(id) ? [agent] : [];
        });
        const rect = areaRect(area, rects);
        const running = members.filter((m) => cardStatus(m, m.role === "principal" ? liveWorkers : 0).tone === "run").length;
        const waiting = members.filter((m) => cardStatus(m, m.role === "principal" ? liveWorkers : 0).tone === "wait").length;
        return {
          area,
          rect,
          count: members.length,
          running,
          waiting,
        };
      }),
    [canvas.areas, rects, byId, liveWorkers, dict.area],
  );
  const bounds = useMemo(
    () =>
      worldBounds(
        [...rects.values()],
        frames.map((f) => f.rect),
        canvas.texts.map((t, i) => ({ x: t.x, y: t.y, text: t.text, big: i === TEXT_BIG_AT })),
      ),
    [rects, frames, canvas.texts],
  );
  // What the room held when it first showed is not arriving; what joins it
  // while it is open is.
  const shown = measured && rects.size > 0;
  // Only what is drawn arrives: a card whose place is not known yet arrives
  // when it shows up, not before.
  const drawn = useMemo(() => agents.filter((a) => rects.has(a.agentId)), [agents, rects]);
  const arrivals = useArrivals(drawn, shown);
  const delegating = useMemo(() => new Set([...arrivals.keys()].flatMap((id) => byId.get(id)?.parentId ?? [])), [arrivals, byId]);
  const newAreas = useNewAreas(
    canvas.areas.map((a) => a.id),
    shown,
  );
  const mm = useMemo(() => minimapMap(bounds), [bounds]);
  const mmRef = useRef<MinimapMap>(mm);
  mmRef.current = mm;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // ─── the camera ───
  const applyCamera = useCallback((cam: Camera) => {
    const world = worldRef.current;
    const bg = bgRef.current;
    const plane = planeRef.current;
    if (world && plane) {
      if (!zooming.current || planeZoom.current === null) planeZoom.current = layoutZoom(cam.z);
      const s = planeStyle(cam, planeZoom.current, !zooming.current, window.devicePixelRatio || 1);
      world.style.transform = s.transform;
      if (plane.style.zoom !== s.zoom) plane.style.zoom = s.zoom;
      world.style.setProperty("--inv", (1 / cam.z).toFixed(4));
    }
    if (bg) {
      if (!zooming.current || !bgZ.current) bgZ.current = cam.z;
      else if (gridNeedsRedraw(cam.z, bgZ.current)) bgZ.current = cam.z;
      const g = gridLayer(cam, bgZ.current, vpSize.current);
      bg.style.transform = g.transform;
      if (g.key !== bgKey.current) {
        bg.style.backgroundImage = g.backgroundImage;
        bg.style.backgroundSize = g.backgroundSize;
        bg.style.backgroundPosition = g.backgroundPosition;
        bg.style.width = `${String(g.width)}px`;
        bg.style.height = `${String(g.height)}px`;
        bgKey.current = g.key;
      }
    }
    const view = mmViewRef.current;
    if (view) {
      const r = minimapView(mmRef.current, cam, vpSize.current);
      view.style.transform = translate(Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10);
      view.style.width = `${r.w.toFixed(1)}px`;
      view.style.height = `${r.h.toFixed(1)}px`;
    }
    const label = zoomLabelRef.current;
    if (label) label.textContent = `${String(Math.round(cam.z * 100))}%`;
  }, []);

  const controller = useRef<CameraController | null>(null);
  controller.current ??= new CameraController(props.canvas.camera ? { x: props.canvas.camera.x, y: props.canvas.camera.y, z: props.canvas.camera.zoom } : { x: 0, y: 0, z: 1 }, {
    apply: applyCamera,
    moving: (on) => {
      worldRef.current?.classList.toggle("moving", on);
    },
    zooming: (on) => {
      zooming.current = on;
      if (!on) bgZ.current = controller.current?.cam.z ?? 1;
    },
    settled: (cam) => {
      setZoomPct(Math.round(cam.z * 100));
      // Where the camera went by itself (fitting a growing room, restoring
      // the saved one) is not something to save: only a person's move is.
      if (!follow.current && !quiet.current) latest.current.onCameraSettled(cam);
    },
  });
  const cam = (): CameraController => controller.current!;

  const fit = useCallback((animate: boolean, byPerson = false) => {
    follow.current = true;
    const target = fitCamera(boundsRef.current, vpSize.current);
    if (animate) cam().animate(target, 460);
    else cam().jump(target);
    // Asking for "fit to screen" is a choice worth keeping; fitting a room
    // that grows by itself is not.
    if (byPerson) latest.current.onCameraSettled(target);
  }, []);

  // Measures the viewport, and keeps the camera right when it resizes.
  useLayoutEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const measure = (): void => {
      const w = vp.clientWidth;
      const h = vp.clientHeight;
      if (w === 0 || h === 0) return;
      if (w === vpSize.current.w && h === vpSize.current.h) return;
      vpSize.current = { w, h };
      bgKey.current = "";
      applyCamera(cam().cam);
      setMeasured(true);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(vp);
    return () => observer.disconnect();
  }, [applyCamera]);

  // The first time there is something to show: where the room was left, or all of it.
  useEffect(() => {
    if (initialized.current || !measured || rects.size === 0) return;
    initialized.current = true;
    const saved = canvas.camera ? { x: canvas.camera.x, y: canvas.camera.y, z: canvas.camera.zoom } : undefined;
    if (saved && cameraShows(saved, boundsRef.current, vpSize.current)) {
      quiet.current = true;
      cam().jump(saved);
      quiet.current = false;
    } else {
      follow.current = true;
      fit(false);
    }
  }, [measured, rects.size, canvas.camera, fit]);

  useEffect(() => () => cam().dispose(), []);
  useEffect(() => {
    // The minimap's frame follows the world when it changes under a still camera.
    applyCamera(cam().cam);
  }, [mm, applyCamera]);

  // The wheel needs a non-passive listener: React's `onWheel` is passive.
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (event: WheelEvent): void => {
      const zoomy = event.ctrlKey || event.metaKey;
      if (!zoomy && (event.target as Element | null)?.closest?.("[data-float]")) return;
      event.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? vpSize.current.h : 1;
      follow.current = false;
      if (zoomy) {
        const dy = event.deltaY * unit;
        if (Math.abs(dy) > 30) {
          const base = cam().effective;
          cam().zoomTo(wheelZoom(base.z, dy, true), mx, my, 180);
        } else {
          const c = cam().cam;
          cam().zoomNow(zoomAround(c, wheelZoom(c.z, dy, false), mx, my));
        }
      } else {
        cam().panBy(-event.deltaX * unit, -event.deltaY * unit);
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  // ─── toasts ───
  const showToast = useCallback((title: string, action?: Toast["action"], ms = 3500) => {
    window.clearTimeout(toastTimer.current);
    setToast({ key: Date.now(), title, action });
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const wasSaveFailed = useRef(false);
  useEffect(() => {
    if (props.saveFailed && !wasSaveFailed.current) showToast(dict.toast.saveFailed, undefined, 6000);
    wasSaveFailed.current = props.saveFailed;
  }, [props.saveFailed, showToast, dict.toast.saveFailed]);

  /** Every change to the layout goes through here: an area is stored with the
   * frame it draws now, so that when its members are gone it does not fall
   * back to wherever it was first made. */
  const commit = useCallback((next: RoomCanvas): void => {
    const cards = cardRects(latest.current.agents, next.positions);
    const stored = { ...next, areas: next.areas.map((a) => storedArea(a, cards)) };
    // Two changes in one tick (an input losing focus, then a tool click) each
    // start from what the one before left, not from the last render.
    latest.current.canvas = stored;
    latest.current.onCanvasChange(stored);
  }, []);

  // ─── helpers over the canvas ───
  const withRects = useCallback((): Map<string, Rect> => {
    const out = new Map(latest.current.agents.length > 0 ? cardRects(latest.current.agents, latest.current.canvas.positions) : []);
    for (const [id, at] of live.current) {
      const base = out.get(id);
      if (base) out.set(id, { ...base, x: at.x, y: at.y });
    }
    return out;
  }, []);

  const writeFrame = useCallback((id: string, rect: Rect): void => {
    const el = worldRef.current?.querySelector<HTMLElement>(`[data-area-id="${CSS.escape(id)}"]`);
    if (el) placeFrame(el, rect);
  }, []);

  const writeEdges = useCallback((rectsNow: ReadonlyMap<string, Rect>, agentId: string): void => {
    const world = worldRef.current;
    if (!world) return;
    for (const a of latest.current.agents) {
      if (a.parentId === undefined || (a.agentId !== agentId && a.parentId !== agentId)) continue;
      const p = rectsNow.get(a.parentId);
      const c = rectsNow.get(a.agentId);
      if (!p || !c) continue;
      const d = edgePath(p, c);
      const len = `${String(pathLength(d))}px`;
      for (const path of world.querySelectorAll<SVGPathElement>(`[data-edge="${CSS.escape(a.agentId)}"]`)) {
        path.setAttribute("d", d);
        path.style.setProperty("--len", len);
      }
    }
  }, []);

  const flag = (id: string | undefined, name: string, on: boolean): void => {
    if (!id) return;
    // A data attribute, not a class: React rewrites `className` whenever the
    // frame's own props change, and a drag in progress must survive that.
    const el = worldRef.current?.querySelector(`[data-area-id="${CSS.escape(id)}"]`);
    if (on) el?.setAttribute(`data-${name}`, "");
    else el?.removeAttribute(`data-${name}`);
  };

  // ─── pointer: pan, drag a card, an area or a text, draw an area ───
  const worldAt = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = vpRef.current!.getBoundingClientRect();
    return screenToWorld(cam().cam, event.clientX - rect.left, event.clientY - rect.top);
  };

  /** The rectangle being drawn by the Area tool, written straight to the DOM:
   * a render per pointer move would redraw every card for it. */
  const paintDraw = (rect: Rect | null): void => {
    const el = drawEl.current;
    if (!el) return;
    if (!rect) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    placeFrame(el, rect);
  };

  /** Keeps the pointer's events coming here once it leaves the viewport. A
   * pointer that is already gone (cancelled, or synthetic) cannot be captured,
   * and that must not stop the gesture. */
  const capture = (pointerId: number): void => {
    try {
      vpRef.current?.setPointerCapture(pointerId);
    } catch {
      // The gesture goes on without capture.
    }
  };

  const beginPan = (event: ReactPointerEvent<HTMLElement>): void => {
    cam().stop();
    const c = cam().cam;
    dragRef.current = { kind: "pan", pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, cx: c.x, cy: c.y, moved: false, samples: [[performance.now(), event.clientX, event.clientY]] };
    capture(event.pointerId);
    if (event.button === 1) event.preventDefault();
  };

  const handMode = (): boolean => latest.current.tool === "hand" || latest.current.spaceDown;

  const onViewportDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    // A second finger while one is dragging something is not a new gesture.
    if (dragRef.current) return;
    const target = event.target as Element;
    if (target.closest("[data-float],[data-nodrag],.sala-node,.sala-text,.sala-frame-bar")) return;
    vpRef.current?.focus({ preventScroll: true });
    const { tool: current } = latest.current;
    if (event.button === 0 && !handMode() && (current === "area" || current === "text")) {
      event.preventDefault();
      const p = worldAt(event);
      if (current === "text") {
        const text: RoomCanvasText = { id: newId("text"), text: "", x: snap(p.x), y: snap(p.y) };
        pendingFocus.current = `text:${text.id}`;
        commit({ ...latest.current.canvas, texts: [...latest.current.canvas.texts, text] });
        setTool("select");
        return;
      }
      dragRef.current = { kind: "draw", pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, ox: snap(p.x), oy: snap(p.y), moved: false };
      capture(event.pointerId);
      paintDraw({ x: snap(p.x), y: snap(p.y), w: 0, h: 0 });
      return;
    }
    beginPan(event);
  };

  const onItemDown = (kind: "node" | "frame" | "text", id: string, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-nodrag]")) return;
    event.stopPropagation();
    if (dragRef.current) return;
    stopSettle();
    vpRef.current?.focus({ preventScroll: true });
    if (handMode() || event.button === 1) {
      beginPan(event);
      return;
    }
    if (target.tagName === "INPUT" && document.activeElement === target) return;
    event.preventDefault();
    cam().stop();
    const { canvas: cv } = latest.current;
    const root = worldRef.current;
    if (kind === "node") {
      const at = cv.positions[id];
      if (!at) return;
      dragRef.current = {
        kind: "node",
        pointerId: event.pointerId,
        id,
        sx: event.clientX,
        sy: event.clientY,
        ox: at.x,
        oy: at.y,
        moved: false,
        el: root?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(id)}"]`) ?? null,
      };
    } else if (kind === "text") {
      const text = cv.texts.find((t) => t.id === id);
      if (!text) return;
      dragRef.current = {
        kind: "text",
        pointerId: event.pointerId,
        id,
        sx: event.clientX,
        sy: event.clientY,
        ox: text.x,
        oy: text.y,
        off: textLift(isBigText(cv.texts, id)),
        moved: false,
        el: root?.querySelector<HTMLElement>(`[data-text-id="${CSS.escape(id)}"]`) ?? null,
        input: target.tagName === "INPUT" ? (target as HTMLInputElement) : null,
      };
    } else {
      const area = cv.areas.find((a) => a.id === id);
      if (!area) return;
      const cards = withRects();
      const rect = areaRect(area, cards);
      dragRef.current = {
        kind: "frame",
        pointerId: event.pointerId,
        id,
        sx: event.clientX,
        sy: event.clientY,
        ox: rect.x,
        oy: rect.y,
        moved: false,
        input: target.tagName === "INPUT" ? (target as HTMLInputElement) : null,
        members: (area.members ?? []).flatMap((m) => {
          const at = cv.positions[m];
          return at && cards.has(m) ? [{ id: m, ox: at.x, oy: at.y }] : [];
        }),
      };
    }
    capture(event.pointerId);
  };

  const onItemDownRef = useRef(onItemDown);
  onItemDownRef.current = onItemDown;
  /** The same function for every card, for as long as the canvas lives: a new
   * one per render would make every card's `memo` useless. */
  const onNodeDown = useCallback((id: string, event: ReactPointerEvent<HTMLElement>): void => onItemDownRef.current("node", id, event), []);

  const onViewportMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.sx;
    const dy = event.clientY - d.sy;
    if (!d.moved) {
      if (dx * dx + dy * dy < 10) return;
      d.moved = true;
      // The world is a layer of its own only while the camera moves (see
      // `.sala-world.moving`); a card or an area moved inside it is not that.
      if (d.kind === "pan") {
        vpRef.current?.setAttribute("data-panning", "");
        worldRef.current?.classList.add("moving");
      } else vpRef.current?.setAttribute("data-dragging", "");
      if (d.kind === "node") d.el?.setAttribute("data-drag", "");
    }
    if (d.kind === "pan") {
      follow.current = false;
      cam().drag({ ...cam().cam, x: d.cx + dx, y: d.cy + dy });
      d.samples.push([performance.now(), event.clientX, event.clientY]);
      if (d.samples.length > 5) d.samples.shift();
      return;
    }
    const z = cam().cam.z;
    if (d.kind === "draw") {
      const p = worldAt(event);
      const x2 = p.x;
      const y2 = p.y;
      paintDraw({ x: Math.min(d.ox, x2), y: Math.min(d.oy, y2), w: Math.abs(x2 - d.ox), h: Math.abs(y2 - d.oy) });
      return;
    }
    if (d.kind === "text") {
      const nx = d.ox + dx / z;
      const ny = d.oy + dy / z;
      if (d.el) d.el.style.transform = translate(nx, ny - d.off);
      return;
    }
    if (d.kind === "node") {
      const nx = d.ox + dx / z;
      const ny = d.oy + dy / z;
      live.current.set(d.id, { x: nx, y: ny });
      if (d.el) d.el.style.transform = translate(nx, ny);
      const now = withRects();
      writeEdges(now, d.id);
      const track = trackDrag(latest.current.canvas.areas, now, d.id);
      for (const area of latest.current.canvas.areas) {
        const isHome = area.id === track.home?.id;
        flag(area.id, "release", isHome && track.leaving);
        flag(area.id, "drop", area.id === track.target?.id);
        if (isHome) {
          const others = new Map(now);
          others.delete(d.id);
          writeFrame(area.id, areaRect(area, track.leaving ? others : now));
        }
      }
      return;
    }
    // An area dragged by its bar takes its members with it.
    for (const m of d.members) live.current.set(m.id, { x: m.ox + dx / z, y: m.oy + dy / z });
    const now = withRects();
    for (const m of d.members) {
      const at = live.current.get(m.id)!;
      const el = worldRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(m.id)}"]`);
      if (el) el.style.transform = translate(at.x, at.y);
      writeEdges(now, m.id);
    }
    const area = latest.current.canvas.areas.find((a) => a.id === d.id);
    if (area) {
      writeFrame(d.id, d.members.length > 0 ? areaRect(area, now) : { ...areaRect(area, now), x: d.ox + dx / z, y: d.oy + dy / z });
    }
  };

  /** Puts every card, link, area and text where the layout says it is. */
  const restoreDom = (): void => {
    const { canvas: cv, agents: list } = latest.current;
    const root = worldRef.current;
    live.current.clear();
    if (!root) return;
    const cards = cardRects(list, cv.positions);
    for (const [id, rect] of cards) {
      const el = root.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(id)}"]`);
      if (el) {
        el.style.transform = translate(rect.x, rect.y);
        el.removeAttribute("data-drag");
      }
      writeEdges(cards, id);
    }
    for (const area of cv.areas) {
      writeFrame(area.id, areaRect(area, cards));
      flag(area.id, "release", false);
      flag(area.id, "drop", false);
    }
    for (const t of cv.texts) {
      const el = root.querySelector<HTMLElement>(`[data-text-id="${CSS.escape(t.id)}"]`);
      if (el) el.style.transform = translate(t.x, t.y - textLift(isBigText(cv.texts, t.id)));
    }
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      vpRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released (cancelled pointer).
    }
    vpRef.current?.removeAttribute("data-panning");
    vpRef.current?.removeAttribute("data-dragging");
    const { canvas: cv, agents: list } = latest.current;

    if (cancelled) {
      // The system took the pointer (a gesture, a notification): nothing was
      // meant by where it stopped, so everything goes back where it was.
      worldRef.current?.classList.remove("moving");
      paintDraw(null);
      if (d.kind === "pan") latest.current.onCameraSettled(cam().cam);
      else restoreDom();
      return;
    }

    if (d.kind === "pan") {
      if (!d.moved) {
        setSelected(null);
        setSelectedArea(null);
        return;
      }
      const { vx, vy } = releaseVelocity(d.samples, performance.now());
      if (Math.hypot(vx, vy) > 2) cam().glide(vx, vy);
      else {
        worldRef.current?.classList.remove("moving");
        latest.current.onCameraSettled(cam().cam);
      }
      return;
    }

    if (d.kind === "draw") {
      paintDraw(null);
      const drawn = { x: d.ox, y: d.oy, w: 0, h: 0 };
      const p = worldAt(event);
      let rect: Rect = { x: Math.min(d.ox, p.x), y: Math.min(d.oy, p.y), w: Math.abs(p.x - d.ox), h: Math.abs(p.y - d.oy) };
      if (!d.moved || rect.w < MIN_DRAWN || rect.h < MIN_DRAWN) rect = { x: drawn.x, y: drawn.y, w: DEFAULT_AREA.w, h: DEFAULT_AREA.h };
      rect = { x: snap(rect.x), y: snap(rect.y), w: snap(rect.w), h: snap(rect.h) };
      const cards = cardRects(list, cv.positions);
      const inside = [...cards.entries()].filter(([, r]) => r.x + r.w / 2 > rect.x && r.x + r.w / 2 < rect.x + rect.w && r.y + r.h / 2 > rect.y && r.y + r.h / 2 < rect.y + rect.h).map(([id]) => id);
      const id = newId("area");
      pendingFocus.current = `area:${id}`;
      commit({ ...cv, areas: groupInto(cv.areas, inside, rect, id) });
      setTool("select");
      return;
    }

    worldRef.current?.classList.remove("moving");

    if (d.kind === "text") {
      d.el?.removeAttribute("data-drag");
      if (!d.moved) {
        d.input?.focus({ preventScroll: true });
        d.input?.select();
        return;
      }
      const z = cam().cam.z;
      const x = snap(d.ox + (event.clientX - d.sx) / z);
      const y = snap(d.oy + (event.clientY - d.sy) / z);
      if (d.el) d.el.style.transform = translate(x, y - d.off);
      commit({ ...cv, texts: cv.texts.map((t) => (t.id === d.id ? { ...t, x, y } : t)) });
      return;
    }

    if (d.kind === "node") {
      d.el?.removeAttribute("data-drag");
      live.current.clear();
      for (const area of cv.areas) {
        flag(area.id, "release", false);
        flag(area.id, "drop", false);
      }
      if (!d.moved) {
        pick(d.id);
        return;
      }
      const z = cam().cam.z;
      const from = { x: d.ox + (event.clientX - d.sx) / z, y: d.oy + (event.clientY - d.sy) / z };
      const x = snap(from.x);
      const y = snap(from.y);
      const positions = { ...cv.positions, [d.id]: { x, y } };
      const cards = cardRects(list, positions);
      const { areas } = membershipAfterDrop(cv.areas, cards, d.id);
      if (d.el) d.el.style.transform = translate(x, y);
      writeEdges(cards, d.id);
      for (const area of areas) writeFrame(area.id, areaRect(area, cards));
      commit({ ...cv, positions, areas });
      if (d.el) settleDrop(d.el, d.id, from.x - x, from.y - y);
      return;
    }

    // Area dragged by its bar.
    live.current.clear();
    if (!d.moved) {
      setSelectedArea(d.id);
      setSelected(null);
      // A click on the name is how it gets edited.
      d.input?.focus({ preventScroll: true });
      d.input?.select();
      return;
    }
    const z = cam().cam.z;
    const sx = snap(d.members[0] ? d.members[0].ox + (event.clientX - d.sx) / z : d.ox + (event.clientX - d.sx) / z) - (d.members[0] ? d.members[0].ox : d.ox);
    const sy = snap(d.members[0] ? d.members[0].oy + (event.clientY - d.sy) / z : d.oy + (event.clientY - d.sy) / z) - (d.members[0] ? d.members[0].oy : d.oy);
    const positions = { ...cv.positions };
    for (const m of d.members) positions[m.id] = { x: m.ox + sx, y: m.oy + sy };
    const areas = cv.areas.map((a) => (a.id === d.id && d.members.length === 0 ? { ...a, x: d.ox + sx, y: d.oy + sy } : a));
    commit({ ...cv, positions, areas });
    const cards = cardRects(list, positions);
    for (const area of areas) writeFrame(area.id, areaRect(area, cards));
    for (const m of d.members) {
      const el = worldRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(m.id)}"]`);
      if (el) el.style.transform = translate(m.ox + sx, m.oy + sy);
      writeEdges(cards, m.id);
    }
  };

  /** A dropped card eases onto its grid spot instead of jumping there. Its
   * place is saved at once; what eases is a `translate` over it (the property,
   * so the `transform` the card is placed by stays the saved one), with its
   * links and its area following. */
  const settling = useRef<{ raf: number; el: HTMLElement } | null>(null);
  const stopSettle = (): void => {
    const s = settling.current;
    if (!s) return;
    settling.current = null;
    cancelAnimationFrame(s.raf);
    s.el.style.translate = "";
    vpRef.current?.removeAttribute("data-dragging");
  };
  const settleDrop = (el: HTMLElement, id: string, dx: number, dy: number): void => {
    stopSettle();
    if ((dx === 0 && dy === 0) || prefersReducedMotion()) return;
    // The area around it follows frame by frame, not on its own transition.
    vpRef.current?.setAttribute("data-dragging", "");
    const t0 = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / DROP_SETTLE_MS);
      const left = 1 - easeOutQuart(k);
      const ox = dx * left;
      const oy = dy * left;
      el.style.translate = k < 1 ? `${String(ox)}px ${String(oy)}px` : "";
      const { canvas: cv, agents: list } = latest.current;
      const cards = cardRects(list, cv.positions);
      const at = cards.get(id);
      if (at) cards.set(id, { ...at, x: at.x + ox, y: at.y + oy });
      writeEdges(cards, id);
      for (const area of cv.areas) if (area.members?.includes(id)) writeFrame(area.id, areaRect(area, cards));
      if (k < 1) settling.current = { raf: requestAnimationFrame(step), el };
      else stopSettle();
    };
    step(t0);
  };
  useEffect(() => () => stopSettle(), []);

  // ─── actions ───
  const select = useCallback((id: string) => {
    setSelected(id);
    setSelectedArea(null);
    setAnswering(null);
  }, []);
  /** A click on a card (or Enter on it). The principal's opens its
   * conversation straight away: it is never selected and has no bar. */
  const pickRef = useRef<(id: string) => void>(() => undefined);
  pickRef.current = (id: string): void => {
    if (byId.get(id)?.role === "principal") {
      setSelected(null);
      setSelectedArea(null);
      setAnswering(null);
      latest.current.onOpenAgent(id);
      return;
    }
    select(id);
  };
  const pick = useCallback((id: string): void => pickRef.current(id), []);
  // The launcher takes the place of whatever was open over the canvas.
  useEffect(() => {
    if (props.newAgentOpen) setAnswering(null);
  }, [props.newAgentOpen]);
  const reply = useCallback((id: string) => {
    setSelected(id);
    setSelectedArea(null);
    setAnswering((current) => (current === id ? null : id));
  }, []);

  const groupAgent = useCallback(
    (agentId: string) => {
      const { canvas: cv, agents: list } = latest.current;
      const cards = cardRects(list, cv.positions);
      const ids = subtreeIds(list, agentId).filter((id) => cards.has(id));
      const rect = areaRectForIds(ids, cards);
      const id = newId("area");
      pendingFocus.current = `area:${id}`;
      commit({ ...cv, areas: groupInto(cv.areas, ids, rect, id) });
      setSelected(null);
    },
    [commit],
  );

  const stopAgent = useCallback(
    (agentId: string) => {
      void latest.current.onStopAgent(agentId).then((ok) => {
        if (!ok) showToast(dict.toast.stopFailed);
      });
    },
    [dict.toast.stopFailed, showToast],
  );

  const [discardAsk, setDiscardAsk] = useState<{ agentId: string; worktrees: RoomWorktree[] } | null>(null);
  const removeAgent = useCallback(
    (agentId: string, discard = false) => {
      setSelected(null);
      void latest.current.onRemoveAgent(agentId, discard).then((result) => {
        if (!result) {
          showToast(dict.toast.removeFailed);
          return;
        }
        if ("needsDiscard" in result) {
          setDiscardAsk({ agentId, worktrees: result.needsDiscard });
          return;
        }
        showToast(
          dict.toast.removed,
          {
            label: dict.toast.undo,
            run: () => {
              void latest.current.onRestoreAgent(agentId).then((ok) => {
                if (ok) setToast(null);
                else showToast(dict.toast.restoreFailed);
              });
            },
          },
          Math.min(result.undoMs, 10_000),
        );
      });
    },
    [dict.toast, showToast],
  );

  useImperativeHandle(props.handleRef, () => ({ removeAgent: (agentId: string) => removeAgent(agentId) }), [removeAgent]);

  const attach = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      void latest.current.onAttachFiles(files).then((ok) => showToast(ok ? dict.toast.attached : dict.toast.attachFailed));
    },
    [dict.toast.attached, dict.toast.attachFailed, showToast],
  );

  const zoomStep = (dir: number): void => {
    follow.current = false;
    const base = cam().effective;
    const next = nextZoomLevel(base.z, dir);
    if (next) cam().zoomTo(next, vpSize.current.w / 2, vpSize.current.h / 2);
  };
  const zoomTo100 = (): void => {
    follow.current = false;
    cam().zoomTo(1, vpSize.current.w / 2, vpSize.current.h / 2);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (event.key === "Escape") {
      // Whatever this press closes is the whole of what it does: the room's
      // panel listens for it too and must not close along.
      if (typing || tool !== "select" || answering !== null || selected !== null || selectedArea !== null) event.preventDefault();
      if (typing) {
        target.blur();
        vpRef.current?.focus({ preventScroll: true });
        return;
      }
      if (tool !== "select") setTool("select");
      else if (answering !== null) setAnswering(null);
      else if (selected !== null || selectedArea !== null) {
        setSelected(null);
        setSelectedArea(null);
      } else latest.current.onEscape();
      return;
    }
    if (typing || event.altKey || event.metaKey || event.ctrlKey) return;
    const key = event.key;
    // Space and Enter on a focused button activate it: they are not shortcuts there.
    if ((key === " " || key === "Enter") && target.closest("button, a, [role=button], [data-float]")) return;
    if (key === " ") {
      event.preventDefault();
      setSpaceDown(true);
      return;
    }
    if (event.shiftKey && (event.code === "Digit1" || key === "!")) {
      event.preventDefault();
      fit(true, true);
      return;
    }
    if (event.shiftKey && (event.code === "Digit0" || key === ")")) {
      event.preventDefault();
      zoomTo100();
      return;
    }
    const lower = key.toLowerCase();
    if (lower === "v") setTool("select");
    else if (lower === "h") setTool("hand");
    else if (lower === "t") setTool("text");
    else if (lower === "r") setTool("area");
    else if (lower === "a") {
      event.preventDefault();
      latest.current.onNewAgent();
    } else if (lower === "i") {
      event.preventDefault();
      latest.current.onAbout();
    } else if (lower === "u") {
      event.preventDefault();
      fileRef.current?.click();
    } else if ((key === "Delete" || key === "Backspace") && selected !== null) {
      const agent = byId.get(selected);
      if (agent?.role === "worker") {
        event.preventDefault();
        removeAgent(selected);
      }
    } else if (key === "+" || key === "=") zoomStep(1);
    else if (key === "-" || key === "_") zoomStep(-1);
  };
  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === " ") setSpaceDown(false);
  };

  // Focus what was just created (an area's name, a text) once it is rendered.
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    const [kind, id] = [want.slice(0, want.indexOf(":")), want.slice(want.indexOf(":") + 1)];
    const input = worldRef.current?.querySelector<HTMLInputElement>(kind === "area" ? `[data-area-id="${CSS.escape(id)}"] input` : `[data-text-id="${CSS.escape(id)}"] input`);
    if (!input) return;
    pendingFocus.current = null;
    input.focus({ preventScroll: true });
  });

  // A card newly placed (a worker the principal delegated to) is brought into view.
  const seenAgents = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!initialized.current) return;
    const seen = seenAgents.current;
    seenAgents.current = new Set(rects.keys());
    if (!seen) return;
    for (const [id, rect] of rects) {
      if (seen.has(id)) continue;
      if (follow.current) {
        cam().animate(fitCamera(boundsRef.current, vpSize.current), 440);
      } else {
        const next = revealCamera(cam().effective, rect, vpSize.current);
        if (next !== cam().effective) cam().animate(next, 440);
      }
      break;
    }
  }, [rects]);
  useEffect(() => {
    if (initialized.current && seenAgents.current === null) seenAgents.current = new Set(rects.keys());
  }, [measured, rects]);

  // ─── area and text editing ───
  const renameArea = (id: string, label: string): void => {
    const current = latest.current.canvas;
    if (current.areas.find((a) => a.id === id)?.label === label) return;
    commit({ ...current, areas: current.areas.map((a) => (a.id === id ? { ...a, label } : a)) });
  };
  // WebKit keeps painting the old pixels of a removed element that carried its
  // own `scale` (an area's label bar) until something else repaints that
  // spot, which showed as a title lingering after its area was gone. Nudging
  // the plane's scale by a hair for one frame repaints all of it at once.
  const repaintPlane = useCallback((): void => {
    requestAnimationFrame(() => {
      const world = worldRef.current;
      if (!world) return;
      world.style.transform = `${world.style.transform} scale(1.0001)`;
      requestAnimationFrame(() => applyCamera(cam().cam));
    });
  }, [applyCamera]);
  const removeArea = (id: string): void => {
    const current = latest.current.canvas;
    commit({ ...current, areas: current.areas.filter((a) => a.id !== id) });
    repaintPlane();
  };
  const editText = (id: string, text: string): void => {
    const current = latest.current.canvas;
    if (text.trim() === "") {
      commit({ ...current, texts: current.texts.filter((t) => t.id !== id) });
      return;
    }
    if (current.texts.find((t) => t.id === id)?.text === text) return;
    commit({ ...current, texts: current.texts.map((t) => (t.id === id ? { ...t, text } : t)) });
  };

  // ─── minimap ───
  const mmDrag = useRef<number | null>(null);
  const mmEl = useRef<HTMLDivElement>(null);
  const centerFromMinimap = (event: ReactPointerEvent<HTMLElement>, animate: boolean): void => {
    const box = mmEl.current?.getBoundingClientRect();
    if (!box) return;
    follow.current = false;
    const p = minimapToWorld(mmRef.current, event.clientX - box.left, event.clientY - box.top);
    const c = cam().effective;
    const target = { x: vpSize.current.w / 2 - p.x * c.z, y: vpSize.current.h / 2 - p.y * c.z, z: c.z };
    if (animate) cam().animate(target, 300);
    else cam().drag(target);
  };

  const mmItems = useMemo(
    () =>
      agents.flatMap((a) => {
        const r = rects.get(a.agentId);
        return r ? [{ id: a.agentId, tone: cardStatus(a, a.role === "principal" ? liveWorkers : 0).tone, rect: minimapRect(mm, r) }] : [];
      }),
    [agents, rects, mm, liveWorkers],
  );

  const cursor = tool === "hand" || spaceDown ? "hand" : "";
  const hasAgents = agents.length > 0;

  return (
    <div
      ref={vpRef}
      className={cn("sala", cursor, tool === "area" && "tool-area", tool === "text" && "tool-text")}
      tabIndex={0}
      role="application"
      aria-roledescription={dict.canvas.label}
      aria-label={dict.canvas.label}
      data-testid="sala-canvas"
      onPointerDown={onViewportDown}
      onPointerMove={onViewportMove}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => finishDrag(event, true)}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => setSpaceDown(false)}
    >
      <div ref={bgRef} className="sala-bg" aria-hidden="true" />
      <div className="sala-vignette" aria-hidden="true" />

      <div ref={worldRef} className="sala-world">
        <div ref={planeRef} className="sala-plane">
          <svg className="sala-edges" aria-hidden="true">
            {agents.map((a, i) => {
              const p = a.parentId === undefined ? undefined : rects.get(a.parentId);
              const c = rects.get(a.agentId);
              if (!p || !c) return null;
              const d = edgePath(p, c);
              const len = { "--len": `${String(pathLength(d))}px` } as CSSProperties;
              const tone = cardStatus(a, a.role === "principal" ? liveWorkers : 0).tone;
              const arriving = arrivals.has(a.agentId);
              return (
                <g key={a.agentId}>
                  <path data-edge={a.agentId} className={cn("sala-edge", linkTone(tone), (selected === a.agentId || selected === a.parentId) && "sel", arriving && "in")} d={d} style={len} />
                  {/* Out of phase from link to link, so a busy room does not pulse in step. */}
                  {tone === "run" &&
                    (["sala-edge-pulse glow", "sala-edge-pulse"] as const).map((cls) => (
                      <path key={cls} data-edge={a.agentId} className={cls} d={d} style={{ ...len, "--d": `${(-((i * 0.37) % 1.9)).toFixed(2)}s` } as CSSProperties} />
                    ))}
                  {arriving && <path data-edge={a.agentId} className="sala-edge-head" d={d} style={len} />}
                </g>
              );
            })}
          </svg>

          {frames.map(({ area, rect, count, running, waiting }) => (
            <div
              key={area.id}
              data-area-id={area.id}
              className={cn("sala-frame", count === 0 && "empty", selectedArea === area.id && "sel", newAreas.has(area.id) && "born")}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            >
              <div className="sala-frame-bar" onPointerDown={(event) => onItemDown("frame", area.id, event)}>
                <input
                  key={`${area.id}:${area.label}`}
                  className="sala-frame-input"
                  aria-label={dict.area.nameLabel}
                  maxLength={AREA_LABEL_MAX}
                  placeholder={dict.area.namePlaceholder}
                  defaultValue={area.label}
                  size={Math.max(8, area.label.length || dict.area.namePlaceholder.length)}
                  autoComplete="off"
                  onBlur={(event) => renameArea(area.id, event.currentTarget.value.trim())}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span className="sala-frame-meta">
                  <span className="sala-frame-count">{count === 1 ? dict.area.agentsOne : dict.area.agents.replace("{count}", String(count))}</span>
                  {running > 0 && <span className="sala-frame-count">· {dict.area.running.replace("{count}", String(running))}</span>}
                  {waiting > 0 && (
                    <span className="sala-frame-wait">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                      {(waiting === 1 ? dict.area.waiting : dict.area.waitingMany).replace("{count}", String(waiting))}
                    </span>
                  )}
                </span>
                <button type="button" className="sala-frame-x" data-nodrag onClick={() => removeArea(area.id)} aria-label={dict.area.remove} title={dict.area.remove}>
                  <CloseIcon size={11} />
                </button>
              </div>
            </div>
          ))}


          {canvas.texts.map((t) => {
            const big = isBigText(canvas.texts, t.id);
            return (
              <div key={t.id} data-text-id={t.id} className="sala-text" style={{ transform: translate(t.x, t.y - textLift(big)) }} onPointerDown={(event) => onItemDown("text", t.id, event)}>
                <input
                  key={`${t.id}:${t.text}`}
                  className={cn("sala-text-input", big && "big")}
                  aria-label={dict.text.label}
                  maxLength={TEXT_MAX}
                  placeholder={dict.text.placeholder}
                  defaultValue={t.text}
                  size={Math.max(6, t.text.length)}
                  autoComplete="off"
                  onBlur={(event) => editText(t.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </div>
            );
          })}

          {agents.map((agent) => {
            const rect = rects.get(agent.agentId);
            if (!rect) return null;
            return (
              <SalaCard
                key={agent.agentId}
                agent={agent}
                x={rect.x}
                y={rect.y}
                w={rect.w}
                h={rect.h}
                selected={selected === agent.agentId}
                hasParent={agent.parentId !== undefined && byId.has(agent.parentId)}
                hasKids={(kids.get(agent.agentId) ?? 0) > 0}
                boot={arrivals.get(agent.agentId)}
                delegating={delegating.has(agent.agentId)}
                modelLabel={props.modelLabelOf(agent)}
                answering={answering === agent.agentId}
                workers={workers}
                liveWorkers={liveWorkers}
                observedSince={props.since.get(agent.agentId)?.since ?? 0}
                canGroup={agent.role === "worker"}
                canStop={agent.role === "worker" && agent.state !== "stopped" && agent.state !== "done"}
                canRemove={agent.role === "worker"}
                onPointerDown={onNodeDown}
                onSelect={pick}
                onOpen={props.onOpenAgent}
                onDelegate={props.onNewAgent}
                onReply={reply}
                onGroup={groupAgent}
                onStop={stopAgent}
                onRemove={removeAgent}
              />
            );
          })}
          {answering !== null &&
            (() => {
              const agent = byId.get(answering);
              const rect = rects.get(answering);
              if (!agent || !rect || agent.needsYou.length === 0) return null;
              return (
                <div className="sala-answer-at" data-answer-for={answering} style={{ transform: translate(rect.x, rect.y + rect.h + 12) }}>
                  {props.renderAnswer(agent, () => setAnswering(null))}
                </div>
              );
            })()}
          <div ref={drawEl} className="sala-frame empty draw" aria-hidden="true" style={{ display: "none" }} />
        </div>
      </div>

      {props.aboutVisible && (
        <button type="button" className="sala-float sala-about" data-float onClick={props.onAbout} aria-label={dict.panel.about} title={dict.panel.about}>
          <AboutIcon size={16} />
        </button>
      )}
      {!hasAgents && <div className="sala-empty">{dict.canvas.empty}</div>}
      {props.reconnecting && (
        <div className="sala-float sala-banner" data-float role="status">
          {dict.canvas.reconnecting}
        </div>
      )}

      <div
        className="sala-float sala-minimap"
        data-float
        aria-label={dict.minimap}
        role="img"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.preventDefault();
          mmDrag.current = event.pointerId;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // The drag goes on without capture.
          }
          centerFromMinimap(event, true);
        }}
        onPointerMove={(event) => {
          if (mmDrag.current === event.pointerId) centerFromMinimap(event, false);
        }}
        onPointerUp={(event) => {
          if (mmDrag.current !== event.pointerId) return;
          mmDrag.current = null;
          latest.current.onCameraSettled(cam().cam);
        }}
        onPointerCancel={() => {
          mmDrag.current = null;
        }}
      >
        <div ref={mmEl} className="sala-minimap-in" style={{ width: MINIMAP_W, height: MINIMAP_H }}>
          {mmItems.map((item) => (
            <span
              key={item.id}
              className={cn("sala-mm-node", item.tone, selected === item.id && "sel")}
              style={{ left: item.rect.x, top: item.rect.y, width: item.rect.w, height: item.rect.h }}
            />
          ))}
          <span ref={mmViewRef} className="sala-mm-view" />
        </div>
      </div>

      {toast && (
        <div key={toast.key} className={cn("sala-float sala-toast", toast.action && "act")} data-float role="status">
          <span>{toast.title}</span>
          {toast.action && (
            <button type="button" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      <SalaToolbar
        tool={tool}
        zoomText={`${String(zoomPct)}%`}
        zoomLabelRef={zoomLabelRef}
        onTool={setTool}
        newAgentOpen={props.newAgentOpen}
        onNewAgent={() => props.onNewAgent()}
        onAttach={() => fileRef.current?.click()}
        onZoomOut={() => zoomStep(-1)}
        onZoomIn={() => zoomStep(1)}
        onZoomReset={zoomTo100}
        onFit={() => fit(true, true)}
      />
      {props.launcher}
      <AlertDialog open={discardAsk !== null} onOpenChange={(open) => !open && setDiscardAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dict.discard.title}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <AlertDialogDescription>
              {dict.discard.body
                .replace("{title}", byId.get(discardAsk?.agentId ?? "")?.title ?? dict.card.untitled)
                .replace("{work}", (discardAsk?.worktrees ?? []).map((w) => w.branch).join(", "))}
            </AlertDialogDescription>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>{dict.discard.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const ask = discardAsk;
                setDiscardAsk(null);
                if (ask) removeAgent(ask.agentId, true);
              }}
            >
              {dict.discard.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="sala-attach-input"
        onChange={(event) => {
          attach([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** The frame a new area gets around `ids`: their cards with the area padding. */
function areaRectForIds(ids: readonly string[], cards: ReadonlyMap<string, Rect>): Rect {
  const rects = ids.flatMap((id) => {
    const r = cards.get(id);
    return r ? [r] : [];
  });
  const box = boundsOf(rects);
  return { x: box.x - AREA_PAD, y: box.y - AREA_PAD, w: box.w + AREA_PAD * 2, h: box.h + AREA_PAD * 2 };
}
