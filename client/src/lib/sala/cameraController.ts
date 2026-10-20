// Moves a `Camera` over time: eased animations, a wheel zoom that coalesces
// its ticks, and the glide after a pan lets go. No React and no DOM of its
// own — it reports through callbacks, which is how the canvas applies the
// camera straight to the DOM on every frame without a render.
import { clamp, clampZoom, type Camera } from "@/lib/sala/camera";

export interface CameraHooks {
  /** The camera changed: write it. Called on every frame of a motion. */
  apply: (cam: Camera) => void;
  /** Something is moving (or stopped): `will-change` is worth having only now. */
  moving: (on: boolean) => void;
  /** A zoom began (`true`) or settled (`false`): the grid is stretched in between. */
  zooming: (on: boolean) => void;
  /** Motion ended: where the camera finally is. */
  settled: (cam: Camera) => void;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 4);
const ZOOM_SETTLE_MS = 170;
const PAN_SETTLE_MS = 150;

export class CameraController {
  cam: Camera;
  /** Where the running animation is headed, if one runs. */
  target: Camera | undefined;
  private raf = 0;
  private zoomTimer: ReturnType<typeof setTimeout> | undefined;
  private panTimer: ReturnType<typeof setTimeout> | undefined;
  private isZooming = false;

  constructor(
    initial: Camera,
    private readonly hooks: CameraHooks,
  ) {
    this.cam = initial;
  }

  /** The camera as far as the person is concerned: where it is going. */
  get effective(): Camera {
    return this.target ?? this.cam;
  }

  /** Jump (no animation). */
  jump(cam: Camera): void {
    this.stop();
    this.cam = cam;
    this.hooks.apply(cam);
    this.hooks.settled(cam);
  }

  /** A gesture moved the camera by hand (pan): written now, no easing. */
  drag(cam: Camera): void {
    this.cam = cam;
    this.hooks.apply(cam);
  }

  /** A wheel gesture panned by a delta. Counts as one movement until the
   * ticks stop, so what loops in the background holds still meanwhile. */
  panBy(dx: number, dy: number): void {
    this.cancelMotion();
    this.cam = { ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy };
    this.hooks.moving(true);
    this.hooks.apply(this.cam);
    clearTimeout(this.panTimer);
    this.panTimer = setTimeout(() => {
      if (!this.raf && !this.isZooming) this.hooks.moving(false);
      this.hooks.settled(this.cam);
    }, PAN_SETTLE_MS);
  }

  /** A fine-grained wheel zoom: immediate, and it counts as one zoom until the ticks stop. */
  zoomNow(cam: Camera): void {
    this.stop();
    this.beginZoom();
    this.cam = cam;
    this.hooks.apply(cam);
  }

  stop(): void {
    this.cancelMotion();
    if (!this.isZooming) this.hooks.moving(false);
  }

  private cancelMotion(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.target = undefined;
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.zoomTimer);
    clearTimeout(this.panTimer);
  }

  private beginZoom(): void {
    if (!this.isZooming) {
      this.isZooming = true;
      this.hooks.zooming(true);
    }
    this.hooks.moving(true);
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => this.endZoom(), ZOOM_SETTLE_MS);
  }

  private endZoom(): void {
    clearTimeout(this.zoomTimer);
    if (!this.isZooming) return;
    this.isZooming = false;
    this.hooks.zooming(false);
    if (!this.raf) this.hooks.moving(false);
    this.hooks.apply(this.cam);
    this.hooks.settled(this.cam);
  }

  /** Eases to `to`. With an `anchor` (a screen point) the zoom keeps the world
   * point under it still all the way, which `to` alone would only do at the end. */
  animate(to: Camera, durationMs: number, anchor?: { x: number; y: number }): void {
    this.stop();
    const from = this.cam;
    const t0 = performance.now();
    const wx = anchor ? (anchor.x - from.x) / from.z : 0;
    const wy = anchor ? (anchor.y - from.y) / from.z : 0;
    this.target = to;
    const zooms = Math.abs(to.z - from.z) > 0.0005;
    this.hooks.moving(true);
    const step = (now: number): void => {
      const t = clamp((now - t0) / durationMs, 0, 1);
      const e = easeOut(t);
      const z = from.z * Math.pow(to.z / from.z, e);
      if (zooms) this.beginZoom();
      this.cam = anchor ? { x: anchor.x - wx * z, y: anchor.y - wy * z, z } : { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z };
      this.hooks.apply(this.cam);
      if (t < 1) {
        this.raf = requestAnimationFrame(step);
        return;
      }
      this.raf = 0;
      this.target = undefined;
      this.cam = { ...to };
      if (zooms) this.endZoom();
      else {
        this.hooks.moving(false);
        this.hooks.apply(this.cam);
        this.hooks.settled(this.cam);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  zoomTo(nz: number, ax: number, ay: number, durationMs = 260): void {
    const z = clampZoom(nz);
    const c = this.effective;
    const wx = (ax - c.x) / c.z;
    const wy = (ay - c.y) / c.z;
    this.animate({ x: ax - wx * z, y: ay - wy * z, z }, durationMs, { x: ax, y: ay });
  }

  /** Keeps panning after the pointer lets go, slowing to a stop. */
  glide(vx: number, vy: number): void {
    this.stop();
    this.hooks.moving(true);
    let last = performance.now();
    const step = (now: number): void => {
      const f = clamp((now - last) / 16.7, 0.2, 3);
      last = now;
      this.cam = { ...this.cam, x: this.cam.x + vx * f, y: this.cam.y + vy * f };
      const k = Math.pow(0.925, f);
      vx *= k;
      vy *= k;
      this.hooks.apply(this.cam);
      if (Math.abs(vx) + Math.abs(vy) > 0.25) {
        this.raf = requestAnimationFrame(step);
        return;
      }
      this.raf = 0;
      this.hooks.moving(false);
      this.hooks.settled(this.cam);
    };
    this.raf = requestAnimationFrame(step);
  }
}

/** The release velocity of a pan, in px per frame, from its last few
 * pointer samples (`[time, x, y]`); zero when the pointer had stopped. */
export function releaseVelocity(samples: readonly (readonly [number, number, number])[], now: number): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const a = samples[0];
  const b = samples[samples.length - 1];
  if (now - b[0] > 70) return { vx: 0, vy: 0 };
  const dt = Math.max(8, b[0] - a[0]);
  return { vx: ((b[1] - a[1]) / dt) * 16.7, vy: ((b[2] - a[2]) / dt) * 16.7 };
}
