// The room canvas's camera: pure math, no DOM. A camera is where the world's
// origin sits on screen (`x`, `y`, in screen px) and how much the world is
// scaled (`z`); a world point `w` lands at `w * z + (x, y)`.

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Spacing of the canvas grid and of the snap cards and areas land on. */
export const GRID = 24;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** The steps `+`/`-` walk through. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function snap(value: number, step: number = GRID): number {
  return Math.round(value / step) * step;
}

export function clampZoom(z: number): number {
  return clamp(z, MIN_ZOOM, MAX_ZOOM);
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z };
}

/** The camera at zoom `nz` that keeps the world point under screen point
 * (`ax`, `ay`) exactly where it is: what zooming "at the cursor" means. */
export function zoomAround(cam: Camera, nz: number, ax: number, ay: number): Camera {
  const z = clampZoom(nz);
  const wx = (ax - cam.x) / cam.z;
  const wy = (ay - cam.y) / cam.z;
  return { x: ax - wx * z, y: ay - wy * z, z };
}

/** The next level of `ZOOM_LEVELS` above (`dir` > 0) or below the zoom, or
 * `undefined` at the end of the ladder. */
export function nextZoomLevel(z: number, dir: number): number | undefined {
  if (dir > 0) return ZOOM_LEVELS.find((level) => level > z + 0.005);
  return [...ZOOM_LEVELS].reverse().find((level) => level < z - 0.005);
}

/** How much a wheel tick zooms: a smooth exponential, so a trackpad's many
 * tiny deltas and a mouse wheel's few big ones feel alike. */
export function wheelZoom(z: number, deltaY: number, precise: boolean): number {
  return clampZoom(z * Math.exp(-deltaY * (precise ? 0.0016 : 0.012)));
}

/** Space the floating chrome keeps clear when fitting or revealing. */
export interface Safe {
  l: number;
  t: number;
  r: number;
  b: number;
}

export const DEFAULT_SAFE: Safe = { l: 12, t: 24, r: 12, b: 56 };

/** The camera that shows all of `box` centred in the viewport, never zoomed
 * in past 100% (a lone card is not blown up) nor out past 30%. */
export function fitCamera(box: Rect, vp: Size, safe: Safe = DEFAULT_SAFE, pad = 28): Camera {
  const aw = Math.max(120, vp.w - safe.l - safe.r - pad * 2);
  const ah = Math.max(120, vp.h - safe.t - safe.b - pad * 2);
  const z = clamp(Math.min(aw / Math.max(1, box.w), ah / Math.max(1, box.h)), 0.3, 1);
  return {
    x: safe.l + pad + (aw - box.w * z) / 2 - box.x * z,
    y: safe.t + pad + (ah - box.h * z) / 2 - box.y * z,
    z,
  };
}

/** The camera that brings `rect` into view with the least movement; the
 * same camera when it already is. */
export function revealCamera(cam: Camera, rect: Rect, vp: Size, safe: Safe = DEFAULT_SAFE): Camera {
  const L = safe.l + 28;
  const R = vp.w - safe.r - 28;
  const T = safe.t + 28;
  const B = vp.h - safe.b - 28;
  const sx = rect.x * cam.z + cam.x;
  const sy = rect.y * cam.z + cam.y;
  const sw = rect.w * cam.z;
  const sh = rect.h * cam.z;
  let dx = 0;
  let dy = 0;
  if (sw > R - L) dx = (L + R) / 2 - (sx + sw / 2);
  else if (sx < L) dx = L - sx;
  else if (sx + sw > R) dx = R - (sx + sw);
  if (sh > B - T) dy = T - sy;
  else if (sy < T) dy = T - sy;
  else if (sy + sh > B) dy = B - (sy + sh);
  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return cam;
  return { x: cam.x + dx, y: cam.y + dy, z: cam.z };
}

/** Whether the camera shows any of `content`: the layout is shared, and a
 * camera saved on a large window would otherwise open a phone onto empty
 * canvas. */
export function cameraShows(cam: Camera, content: Rect, vp: Size): boolean {
  const left = -cam.x / cam.z;
  const top = -cam.y / cam.z;
  const right = left + vp.w / cam.z;
  const bottom = top + vp.h / cam.z;
  return left < content.x + content.w && right > content.x && top < content.y + content.h && bottom > content.y;
}

/** The camera that puts world point (`wx`, `wy`) at the viewport's centre. */
export function centerCamera(cam: Camera, wx: number, wy: number, vp: Size): Camera {
  return { x: vp.w / 2 - wx * cam.z, y: vp.h / 2 - wy * cam.z, z: cam.z };
}

/** The smallest rectangle holding every rect (a default when none). */
export function boundsOf(rects: readonly Rect[], fallback: Rect = { x: 0, y: 0, w: 400, h: 300 }): Rect {
  if (rects.length === 0) return fallback;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ─── minimap ───

export const MINIMAP_W = 136;
export const MINIMAP_H = 84;

export interface MinimapMap {
  /** World point at the minimap's top-left. */
  ox: number;
  oy: number;
  /** Minimap px per world unit. */
  s: number;
  /** Letterboxing inside the minimap. */
  offX: number;
  offY: number;
}

/** How the world's `bounds` map onto the minimap: padded so the view
 * rectangle has room to sit past the edge of the content. */
export function minimapMap(bounds: Rect): MinimapMap {
  const pad = Math.max(bounds.w, bounds.h) * 0.32;
  const rx = bounds.x - pad;
  const ry = bounds.y - pad;
  const rw = bounds.w + pad * 2;
  const rh = bounds.h + pad * 2;
  const s = Math.min(MINIMAP_W / rw, MINIMAP_H / rh);
  return { ox: rx, oy: ry, s, offX: (MINIMAP_W - rw * s) / 2, offY: (MINIMAP_H - rh * s) / 2 };
}

export function minimapRect(map: MinimapMap, r: Rect): Rect {
  return { x: (r.x - map.ox) * map.s + map.offX, y: (r.y - map.oy) * map.s + map.offY, w: Math.max(2, r.w * map.s), h: Math.max(2, r.h * map.s) };
}

/** The rectangle of the world the viewport shows, in minimap px. */
export function minimapView(map: MinimapMap, cam: Camera, vp: Size): Rect {
  return {
    x: (-cam.x / cam.z - map.ox) * map.s + map.offX,
    y: (-cam.y / cam.z - map.oy) * map.s + map.offY,
    w: (vp.w / cam.z) * map.s,
    h: (vp.h / cam.z) * map.s,
  };
}

/** The world point under a point of the minimap. */
export function minimapToWorld(map: MinimapMap, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - map.offX) / map.s + map.ox, y: (my - map.offY) / map.s + map.oy };
}

// ─── the plane ───

/**
 * The lowest zoom the plane is laid out at. WebKit holds text that a CSS
 * `zoom` shrinks to its minimum logical font size (9px): laid out at 0.3, the
 * cards' 11.5px text stays 9px and spills out of them. At 0.9 the plane's
 * text is still above it (the cards' smallest is 11px); below, the plane is
 * laid out at this zoom and scaled down the rest of the way.
 */
export const MIN_LAYOUT_ZOOM = 0.9;

/** The zoom the plane is laid out at for a camera zoom `z`. */
export function layoutZoom(z: number): number {
  return Math.max(z, MIN_LAYOUT_ZOOM);
}

export interface PlaneStyle {
  /** The inner plane's CSS `zoom`: the scale its text and borders are laid out and painted at. */
  zoom: string;
  /** The outer plane's `transform`: where it sits, and what is left of the scale. */
  transform: string;
}

/**
 * How the plane is drawn for a camera. The scale is a CSS `zoom` (layout at
 * the real size), never a `transform: scale()` at rest: WebKit rasterises a
 * composited layer at its unscaled size and stretches the bitmap by its
 * transform, and the plane gets its own layer for reasons out of its hands —
 * a looping animation in a card, a scroller anywhere in the window — so a
 * scaled plane went soft at any zoom but 100%. Laid out at the real size,
 * whatever layer it lands in is painted at the real size.
 *
 * `zoomAt` is the zoom the plane is laid out at: `layoutZoom(cam.z)` at rest,
 * and the one from before a zoom gesture while it is in flight, so the
 * gesture is only a transform (no layout per frame) and the layout catches up
 * once, when it settles. At rest the offset is snapped to device pixels: a
 * layer at a fractional offset is resampled, which softens it as well.
 */
export function planeStyle(cam: Camera, zoomAt: number, rest: boolean, dpr: number): PlaneStyle {
  const k = cam.z / zoomAt;
  const x = rest ? Math.round(cam.x * dpr) / dpr : cam.x;
  const y = rest ? Math.round(cam.y * dpr) / dpr : cam.y;
  const translate = `translate(${String(x)}px, ${String(y)}px)`;
  return { zoom: String(zoomAt), transform: k === 1 ? translate : `${translate} scale(${k.toFixed(5)})` };
}

// ─── grid backdrop ───

export interface GridLayer {
  /** CSS for the oversized layer; only changes when `key` does. */
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  width: number;
  height: number;
  /** Re-rasterize the layer's background only when this changes. */
  key: string;
  /** The layer's transform: where it sits, and its stretch while a zoom is
   * in flight on top of the last raster. */
  transform: string;
}

/**
 * The grid behind the cards, as one layer the compositor moves and scales.
 * Panning only rewrites `transform` (the layer is larger than the viewport by
 * one big cell, and the offset wraps around that cell), so a pan never
 * re-rasterizes the gradients; `bgZ` is the zoom the gradients were last
 * drawn at, and a zoom in flight stretches that raster until it drifts too
 * far to look right. Lines every three cells; dots in the middle of the
 * cells, never on a line (the dot layer is shifted half a cell).
 */
export function gridLayer(cam: Camera, bgZ: number, vp: Size): GridLayer {
  const z0 = bgZ;
  const k = cam.z / z0;
  const S0 = GRID * z0;
  const L0 = GRID * 3 * z0;
  const L = L0 * k;
  const ox = (((cam.x % L) + L) % L) - L;
  const oy = (((cam.y % L) + L) % L) - L;
  const f = (n: number): string => n.toFixed(3);
  const px = (n: number): string => `${n.toFixed(3)}px`;
  const dotA = clamp((S0 - 6) / 10, 0, 1) * 0.075;
  const lineA = 0.034 * clamp(0.55 + z0 * 0.45, 0.55, 1);
  const width = Math.ceil((vp.w + 2 * L0 + 16) / 0.7);
  const height = Math.ceil((vp.h + 2 * L0 + 16) / 0.7);
  const line = `rgba(255,240,225,${f(lineA)})`;
  return {
    backgroundImage: `radial-gradient(circle, rgba(255,240,225,${f(dotA)}) 1px, transparent 1px), linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
    backgroundSize: `${px(S0)} ${px(S0)}, ${px(L0)} ${px(L0)}, ${px(L0)} ${px(L0)}`,
    backgroundPosition: `${px(0.5)} ${px(0.5)}, 0 0, 0 0`,
    width,
    height,
    key: `${z0.toFixed(5)}|${String(width)}x${String(height)}`,
    transform: `translate(${ox.toFixed(2)}px, ${oy.toFixed(2)}px) scale(${k.toFixed(5)})`,
  };
}

/** Whether a zoom in flight has stretched the last raster far enough that
 * the grid should be drawn again at the current zoom. */
export function gridNeedsRedraw(z: number, bgZ: number): boolean {
  const k = z / bgZ;
  return k < 0.72 || k > 1.42;
}
