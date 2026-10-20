import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import "@/components/sala/sala.css";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import type { RoomAgent, RoomAgentState, RoomCanvas, RoomCanvasArea, RoomCanvasText } from "@/lib/relay/roomClient";
import {
  MINIMAP_H,
  MINIMAP_W,
  boundsOf,
  fitCamera,
  gridLayer,
  gridNeedsRedraw,
  minimapMap,
  minimapRect,
  minimapToWorld,
  minimapView,
  nextZoomLevel,
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
import { AREA_PAD, areaRect, cardRects, edgePath, groupInto, membershipAfterDrop, subtreeIds, trackDrag, worldBounds } from "@/lib/sala/layout";
import { SalaCard } from "@/components/sala/SalaCard";
import { SalaToolbar, type SalaTool } from "@/components/sala/SalaToolbar";
import { CloseIcon } from "@/components/sala/SalaIcons";

export interface SalaCanvasProps {
  agents: readonly RoomAgent[];
  since: ReadonlyMap<string, { state: RoomAgentState; since: number }>;
  canvas: RoomCanvas;
  contextCount: number;
  modelLabelOf: (agent: RoomAgent) => string;
  reconnecting: boolean;
  onCanvasChange: (next: RoomCanvas) => void;
  /** The camera came to rest (or was set): where it is now. */
  onCameraSettled: (camera: Camera) => void;
  onStopAgent: (agentId: string) => Promise<boolean>;
  onRemoveAgent: (agentId: string) => Promise<{ undoMs: number } | null>;
  onRestoreAgent: (agentId: string) => Promise<boolean>;
  onAttachFiles: (files: File[]) => Promise<boolean>;
}

interface Toast {
  key: number;
  title: string;
  action?: { label: string; run: () => void };
}

type Drag =
  | { kind: "pan"; pointerId: number; sx: number; sy: number; cx: number; cy: number; moved: boolean; samples: [number, number, number][] }
  | { kind: "node"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; el: HTMLElement | null }
  | { kind: "frame"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; members: { id: string; ox: number; oy: number }[] }
  | { kind: "text"; pointerId: number; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; el: HTMLElement | null; input: HTMLInputElement | null }
  | { kind: "draw"; pointerId: number; sx: number; sy: number; ox: number; oy: number; moved: boolean };

const TEXT_BIG_AT = 0; // the first text is a heading: see `isBigText`
const MIN_DRAWN = 48;
const DEFAULT_AREA = { w: 480, h: 312 };

/** Texts on the canvas read as a heading when they are the first one: the
 * relay stores no size, and the design's one title is the room's name. */
function isBigText(texts: readonly RoomCanvasText[], id: string): boolean {
  return texts[TEXT_BIG_AT]?.id === id;
}

const translate = (x: number, y: number): string => `translate(${String(x)}px, ${String(y)}px)`;

let nextId = 0;
const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${String((nextId += 1))}`;

export function SalaCanvas(props: SalaCanvasProps) {
  const dict = useDict().sala;
  const { agents, canvas } = props;
  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const mmViewRef = useRef<HTMLSpanElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<SalaTool>("select");
  const [spaceDown, setSpaceDown] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [measured, setMeasured] = useState(false);
  const [draw, setDraw] = useState<Rect | null>(null);

  // What event handlers need, as of the latest render.
  const latest = useRef({ ...props, tool, spaceDown, selected });
  latest.current = { ...props, tool, spaceDown, selected };
  const vpSize = useRef({ w: 0, h: 0 });
  const live = useRef(new Map<string, { x: number; y: number }>());
  const dragRef = useRef<Drag | null>(null);
  const bgZ = useRef(1);
  const bgKey = useRef("");
  const zooming = useRef(false);
  const initialized = useRef(false);
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
        return {
          area,
          rect: areaRect(area, rects),
          count: members.length,
          running: members.filter((m) => cardStatus(m, m.role === "principal" ? liveWorkers : 0).tone === "run").length,
          waiting: members.filter((m) => cardStatus(m, m.role === "principal" ? liveWorkers : 0).tone === "wait").length,
        };
      }),
    [canvas.areas, rects, byId, liveWorkers],
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
  const mm = useMemo(() => minimapMap(bounds), [bounds]);
  const mmRef = useRef<MinimapMap>(mm);
  mmRef.current = mm;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // ─── the camera ───
  const applyCamera = useCallback((cam: Camera) => {
    const world = worldRef.current;
    const bg = bgRef.current;
    if (world) {
      world.style.transform = `${translate(cam.x, cam.y)} scale(${cam.z.toFixed(4)})`;
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
      vpRef.current?.classList.toggle("moving", on);
    },
    zooming: (on) => {
      zooming.current = on;
      if (!on) bgZ.current = controller.current?.cam.z ?? 1;
    },
    settled: (cam) => {
      setZoomPct(Math.round(cam.z * 100));
      latest.current.onCameraSettled(cam);
    },
  });
  const cam = (): CameraController => controller.current!;

  const fit = useCallback((animate: boolean) => {
    follow.current = true;
    const target = fitCamera(boundsRef.current, vpSize.current);
    if (animate) cam().animate(target, 460);
    else cam().jump(target);
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
    if (canvas.camera) cam().jump({ x: canvas.camera.x, y: canvas.camera.y, z: canvas.camera.zoom });
    else fit(false);
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
    if (!el) return;
    el.style.transform = translate(rect.x, rect.y);
    el.style.width = `${String(rect.w)}px`;
    el.style.height = `${String(rect.h)}px`;
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
      for (const path of world.querySelectorAll<SVGPathElement>(`[data-edge="${CSS.escape(a.agentId)}"]`)) path.setAttribute("d", d);
    }
  }, []);

  const flag = (id: string | undefined, name: string, on: boolean): void => {
    if (!id) return;
    worldRef.current?.querySelector(`[data-area-id="${CSS.escape(id)}"]`)?.classList.toggle(name, on);
  };

  // ─── pointer: pan, drag a card, an area or a text, draw an area ───
  const worldAt = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = vpRef.current!.getBoundingClientRect();
    return screenToWorld(cam().cam, event.clientX - rect.left, event.clientY - rect.top);
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
        latest.current.onCanvasChange({ ...latest.current.canvas, texts: [...latest.current.canvas.texts, text] });
        setTool("select");
        return;
      }
      dragRef.current = { kind: "draw", pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, ox: snap(p.x), oy: snap(p.y), moved: false };
      capture(event.pointerId);
      setDraw({ x: snap(p.x), y: snap(p.y), w: 0, h: 0 });
      return;
    }
    beginPan(event);
  };

  const onItemDown = (kind: "node" | "frame" | "text", id: string, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-nodrag]")) return;
    event.stopPropagation();
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
        members: (area.members ?? []).flatMap((m) => {
          const at = cv.positions[m];
          return at && cards.has(m) ? [{ id: m, ox: at.x, oy: at.y }] : [];
        }),
      };
    }
    capture(event.pointerId);
  };

  const onViewportMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.sx;
    const dy = event.clientY - d.sy;
    if (!d.moved) {
      if (dx * dx + dy * dy < 10) return;
      d.moved = true;
      if (d.kind === "pan") vpRef.current?.classList.add("panning");
      else {
        vpRef.current?.classList.add("moving");
        worldRef.current?.classList.add("moving");
      }
      if (d.kind === "node") d.el?.classList.add("drag");
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
      setDraw({ x: Math.min(d.ox, x2), y: Math.min(d.oy, y2), w: Math.abs(x2 - d.ox), h: Math.abs(y2 - d.oy) });
      return;
    }
    if (d.kind === "text") {
      const nx = d.ox + dx / z;
      const ny = d.oy + dy / z;
      if (d.el) d.el.style.transform = translate(nx, ny);
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

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      vpRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released (cancelled pointer).
    }
    vpRef.current?.classList.remove("panning");
    const { canvas: cv, agents: list } = latest.current;

    if (d.kind === "pan") {
      if (!d.moved) {
        setSelected(null);
        setSelectedArea(null);
        return;
      }
      vpRef.current?.classList.remove("moving");
      const { vx, vy } = releaseVelocity(d.samples, performance.now());
      if (Math.hypot(vx, vy) > 2) cam().glide(vx, vy);
      else {
        worldRef.current?.classList.remove("moving");
        latest.current.onCameraSettled(cam().cam);
      }
      return;
    }

    if (d.kind === "draw") {
      setDraw(null);
      const drawn = { x: d.ox, y: d.oy, w: 0, h: 0 };
      const p = worldAt(event);
      let rect: Rect = { x: Math.min(d.ox, p.x), y: Math.min(d.oy, p.y), w: Math.abs(p.x - d.ox), h: Math.abs(p.y - d.oy) };
      if (!d.moved || rect.w < MIN_DRAWN || rect.h < MIN_DRAWN) rect = { x: drawn.x, y: drawn.y, w: DEFAULT_AREA.w, h: DEFAULT_AREA.h };
      rect = { x: snap(rect.x), y: snap(rect.y), w: snap(rect.w), h: snap(rect.h) };
      const cards = cardRects(list, cv.positions);
      const inside = [...cards.entries()].filter(([, r]) => r.x + r.w / 2 > rect.x && r.x + r.w / 2 < rect.x + rect.w && r.y + r.h / 2 > rect.y && r.y + r.h / 2 < rect.y + rect.h).map(([id]) => id);
      const id = newId("area");
      pendingFocus.current = `area:${id}`;
      latest.current.onCanvasChange({ ...cv, areas: groupInto(cv.areas, inside, rect, id) });
      setTool("select");
      return;
    }

    worldRef.current?.classList.remove("moving");
    vpRef.current?.classList.remove("moving");

    if (d.kind === "text") {
      d.el?.classList.remove("drag");
      if (!d.moved) {
        d.input?.focus({ preventScroll: true });
        d.input?.select();
        return;
      }
      const z = cam().cam.z;
      const x = snap(d.ox + (event.clientX - d.sx) / z);
      const y = snap(d.oy + (event.clientY - d.sy) / z);
      if (d.el) d.el.style.transform = translate(x, y);
      latest.current.onCanvasChange({ ...cv, texts: cv.texts.map((t) => (t.id === d.id ? { ...t, x, y } : t)) });
      return;
    }

    if (d.kind === "node") {
      d.el?.classList.remove("drag");
      live.current.clear();
      for (const area of cv.areas) {
        flag(area.id, "release", false);
        flag(area.id, "drop", false);
      }
      if (!d.moved) {
        setSelected(d.id);
        setSelectedArea(null);
        return;
      }
      const z = cam().cam.z;
      const x = snap(d.ox + (event.clientX - d.sx) / z);
      const y = snap(d.oy + (event.clientY - d.sy) / z);
      const positions = { ...cv.positions, [d.id]: { x, y } };
      const cards = cardRects(list, positions);
      const { areas } = membershipAfterDrop(cv.areas, cards, d.id);
      if (d.el) d.el.style.transform = translate(x, y);
      writeEdges(cards, d.id);
      for (const area of areas) writeFrame(area.id, areaRect(area, cards));
      latest.current.onCanvasChange({ ...cv, positions, areas });
      return;
    }

    // Area dragged by its bar.
    live.current.clear();
    if (!d.moved) {
      setSelectedArea(d.id);
      setSelected(null);
      return;
    }
    const z = cam().cam.z;
    const sx = snap(d.members[0] ? d.members[0].ox + (event.clientX - d.sx) / z : d.ox + (event.clientX - d.sx) / z) - (d.members[0] ? d.members[0].ox : d.ox);
    const sy = snap(d.members[0] ? d.members[0].oy + (event.clientY - d.sy) / z : d.oy + (event.clientY - d.sy) / z) - (d.members[0] ? d.members[0].oy : d.oy);
    const positions = { ...cv.positions };
    for (const m of d.members) positions[m.id] = { x: m.ox + sx, y: m.oy + sy };
    const areas = cv.areas.map((a) => (a.id === d.id && d.members.length === 0 ? { ...a, x: d.ox + sx, y: d.oy + sy } : a));
    latest.current.onCanvasChange({ ...cv, positions, areas });
    const cards = cardRects(list, positions);
    for (const area of areas) writeFrame(area.id, areaRect(area, cards));
    for (const m of d.members) {
      const el = worldRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(m.id)}"]`);
      if (el) el.style.transform = translate(m.ox + sx, m.oy + sy);
      writeEdges(cards, m.id);
    }
  };

  // ─── actions ───
  const select = useCallback((id: string) => {
    setSelected(id);
    setSelectedArea(null);
  }, []);

  const groupAgent = useCallback(
    (agentId: string) => {
      const { canvas: cv, agents: list } = latest.current;
      const cards = cardRects(list, cv.positions);
      const ids = subtreeIds(list, agentId).filter((id) => cards.has(id));
      const rect = areaRectForIds(ids, cards);
      const id = newId("area");
      pendingFocus.current = `area:${id}`;
      latest.current.onCanvasChange({ ...cv, areas: groupInto(cv.areas, ids, rect, id) });
      setSelected(null);
    },
    [],
  );

  const stopAgent = useCallback(
    (agentId: string) => {
      void latest.current.onStopAgent(agentId).then((ok) => {
        if (!ok) showToast(dict.toast.stopFailed);
      });
    },
    [dict.toast.stopFailed, showToast],
  );

  const removeAgent = useCallback(
    (agentId: string) => {
      setSelected(null);
      void latest.current.onRemoveAgent(agentId).then((result) => {
        if (!result) {
          showToast(dict.toast.removeFailed);
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
      if (typing) {
        target.blur();
        vpRef.current?.focus({ preventScroll: true });
        return;
      }
      if (tool !== "select") setTool("select");
      else {
        setSelected(null);
        setSelectedArea(null);
      }
      return;
    }
    if (typing || event.altKey || event.metaKey || event.ctrlKey) return;
    const key = event.key;
    // Space and Enter on a focused toolbar button activate it: they are not shortcuts there.
    if ((key === " " || key === "Enter") && target.closest("[data-float]")) return;
    if (key === " ") {
      event.preventDefault();
      setSpaceDown(true);
      return;
    }
    if (event.shiftKey && (event.code === "Digit1" || key === "!")) {
      event.preventDefault();
      fit(true);
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
    else if (lower === "u") {
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
  const setAreas = (areas: RoomCanvasArea[]): void => props.onCanvasChange({ ...canvas, areas });
  const renameArea = (id: string, label: string): void => {
    if (canvas.areas.find((a) => a.id === id)?.label === label) return;
    setAreas(canvas.areas.map((a) => (a.id === id ? { ...a, label } : a)));
  };
  const removeArea = (id: string): void => setAreas(canvas.areas.filter((a) => a.id !== id));
  const editText = (id: string, text: string): void => {
    if (text.trim() === "") {
      props.onCanvasChange({ ...canvas, texts: canvas.texts.filter((t) => t.id !== id) });
      return;
    }
    if (canvas.texts.find((t) => t.id === id)?.text === text) return;
    props.onCanvasChange({ ...canvas, texts: canvas.texts.map((t) => (t.id === id ? { ...t, text } : t)) });
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
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => setSpaceDown(false)}
    >
      <div ref={bgRef} className="sala-bg" aria-hidden="true" />
      <div className="sala-vignette" aria-hidden="true" />

      <div ref={worldRef} className="sala-world">
        {frames.map(({ area, rect, count, running, waiting }) => (
          <div
            key={area.id}
            data-area-id={area.id}
            className={cn("sala-frame", count === 0 && "empty", selectedArea === area.id && "sel")}
            style={{ transform: translate(rect.x, rect.y), width: rect.w, height: rect.h }}
          >
            <div className="sala-frame-bar" onPointerDown={(event) => onItemDown("frame", area.id, event)}>
              <input
                key={`${area.id}:${area.label}`}
                className="sala-frame-input"
                aria-label={dict.area.nameLabel}
                placeholder={dict.area.namePlaceholder}
                defaultValue={area.label}
                size={Math.max(8, area.label.length || dict.area.namePlaceholder.length)}
                autoComplete="off"
                onBlur={(event) => renameArea(area.id, event.currentTarget.value.trim())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="sala-frame-count">{count === 1 ? dict.area.agentsOne : dict.area.agents.replace("{count}", String(count))}</span>
              {running > 0 && <span className="sala-frame-count">· {dict.area.running.replace("{count}", String(running))}</span>}
              {waiting > 0 && (
                <span className="sala-frame-wait">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                  {dict.area.waiting.replace("{count}", String(waiting))}
                </span>
              )}
              <button type="button" className="sala-frame-x" data-nodrag onClick={() => removeArea(area.id)} aria-label={dict.area.remove} title={dict.area.remove}>
                <CloseIcon size={11} />
              </button>
            </div>
          </div>
        ))}

        <svg className="sala-edges" aria-hidden="true">
          {agents.map((a) => {
            const p = a.parentId === undefined ? undefined : rects.get(a.parentId);
            const c = rects.get(a.agentId);
            if (!p || !c) return null;
            const d = edgePath(p, c);
            const tone = cardStatus(a, a.role === "principal" ? liveWorkers : 0).tone;
            return (
              <g key={a.agentId}>
                <path data-edge={a.agentId} className={cn("sala-edge", (tone === "done" || tone === "stop") && "done", selected === a.agentId && "sel")} d={d} />
                {(tone === "run" || tone === "wait") && <path data-edge={a.agentId} className={cn("sala-edge-flow", tone === "wait" && "wait")} d={d} />}
              </g>
            );
          })}
        </svg>

        {canvas.texts.map((t) => {
          const big = isBigText(canvas.texts, t.id);
          return (
            <div key={t.id} data-text-id={t.id} className="sala-text" style={{ transform: translate(t.x, t.y - (big ? 42 : 22)) }} onPointerDown={(event) => onItemDown("text", t.id, event)}>
              <input
                key={`${t.id}:${t.text}`}
                className={cn("sala-text-input", big && "big")}
                aria-label={dict.text.label}
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
              modelLabel={props.modelLabelOf(agent)}
              contextCount={props.contextCount}
              workers={workers}
              liveWorkers={liveWorkers}
              observedSince={props.since.get(agent.agentId)?.since ?? 0}
              canGroup={agent.role === "worker"}
              canStop={agent.role === "worker" && agent.state !== "stopped" && agent.state !== "done"}
              canRemove={agent.role === "worker"}
              onPointerDown={(id, event) => onItemDown("node", id, event)}
              onSelect={select}
              onGroup={groupAgent}
              onStop={stopAgent}
              onRemove={removeAgent}
            />
          );
        })}
        {draw && <div className="sala-frame" style={{ transform: translate(draw.x, draw.y), width: draw.w, height: draw.h, borderStyle: "dashed" }} />}
      </div>

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
        onAttach={() => fileRef.current?.click()}
        onZoomOut={() => zoomStep(-1)}
        onZoomIn={() => zoomStep(1)}
        onZoomReset={zoomTo100}
        onFit={() => fit(true)}
      />
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
