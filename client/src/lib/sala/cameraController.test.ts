import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController, releaseVelocity, type CameraHooks } from "@/lib/sala/cameraController";

function hooks(): CameraHooks & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    apply: () => log.push("apply"),
    moving: (on) => log.push(on ? "moving" : "still"),
    zooming: (on) => log.push(on ? "zoom" : "unzoom"),
    settled: () => log.push("settled"),
  };
}

describe("releaseVelocity", () => {
  it("is zero with fewer than two samples or a pointer that had stopped", () => {
    expect(releaseVelocity([], 100)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([[0, 0, 0], [16, 10, 0]], 500)).toEqual({ vx: 0, vy: 0 });
  });
  it("is pixels per frame in the direction of the drag", () => {
    const { vx, vy } = releaseVelocity([[0, 0, 0], [16.7, 20, -10]], 20);
    expect(vx).toBeCloseTo(20, 1);
    expect(vy).toBeCloseTo(-10, 1);
  });
});

describe("CameraController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let id = 0;
    const pending = new Map<number, ReturnType<typeof setTimeout>>();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      id += 1;
      pending.set(id, setTimeout(() => cb(performance.now()), 16));
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
      clearTimeout(pending.get(frame));
      pending.delete(frame);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("jump moves at once and reports it settled", () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.jump({ x: 5, y: 6, z: 2 });
    expect(c.cam).toEqual({ x: 5, y: 6, z: 2 });
    expect(h.log).toContain("settled");
  });

  it("reports where it is headed while an animation runs", () => {
    const c = new CameraController({ x: 0, y: 0, z: 1 }, hooks());
    c.animate({ x: 100, y: 0, z: 1 }, 100);
    expect(c.effective).toEqual({ x: 100, y: 0, z: 1 });
  });

  it("ends an animation exactly on its target and settles once", async () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.animate({ x: 100, y: 40, z: 1 }, 50);
    await vi.advanceTimersByTimeAsync(400);
    expect(c.cam).toEqual({ x: 100, y: 40, z: 1 });
    expect(h.log.filter((e) => e === "settled")).toHaveLength(1);
    expect(h.log[h.log.length - 1]).toBe("settled");
  });

  it("flags a zoom as one while its ticks keep coming, and settles after", async () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.zoomNow({ x: 0, y: 0, z: 1.1 });
    c.zoomNow({ x: 0, y: 0, z: 1.2 });
    expect(h.log.filter((e) => e === "zoom")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.log).toContain("unzoom");
    expect(h.log[h.log.length - 1]).toBe("settled");
  });

  it("keeps the anchored world point still through an animated zoom", async () => {
    const c = new CameraController({ x: 0, y: 0, z: 1 }, hooks());
    const before = { x: (200 - 0) / 1, y: (150 - 0) / 1 };
    c.zoomTo(2, 200, 150, 60);
    await vi.advanceTimersByTimeAsync(400);
    expect((200 - c.cam.x) / c.cam.z).toBeCloseTo(before.x, 4);
    expect((150 - c.cam.y) / c.cam.z).toBeCloseTo(before.y, 4);
    expect(c.cam.z).toBe(2);
  });

  it("treats a run of wheel pans as one movement: still only after the ticks stop", async () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.panBy(10, 0);
    c.panBy(10, 5);
    c.panBy(10, 5);
    expect(c.cam).toEqual({ x: 30, y: 10, z: 1 });
    expect(h.log.filter((e) => e === "moving")).toHaveLength(3);
    expect(h.log).not.toContain("still");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.log.filter((e) => e === "still")).toHaveLength(1);
    expect(h.log.filter((e) => e === "settled")).toHaveLength(1);
  });

  it("reports where a motion that was cut short ended, so the camera is not lost", async () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.animate({ x: 500, y: 0, z: 1 }, 400);
    await vi.advanceTimersByTimeAsync(120);
    const before = h.log.filter((e) => e === "settled").length;
    c.stop();
    expect(h.log.filter((e) => e === "settled").length).toBe(before + 1);
    // Stopping what is not moving says nothing.
    c.stop();
    expect(h.log.filter((e) => e === "settled").length).toBe(before + 1);
  });

  it("lets a hand on the camera win over an animation that is still running", async () => {
    const c = new CameraController({ x: 0, y: 0, z: 1 }, hooks());
    c.animate({ x: 500, y: 0, z: 1 }, 300);
    c.drag({ x: 40, y: 0, z: 1 });
    await vi.advanceTimersByTimeAsync(600);
    expect(c.cam).toEqual({ x: 40, y: 0, z: 1 });
  });

  it("glides to a stop", async () => {
    const h = hooks();
    const c = new CameraController({ x: 0, y: 0, z: 1 }, h);
    c.glide(20, 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.cam.x).toBeGreaterThan(20);
    expect(c.cam.x).toBeLessThan(2000);
    expect(h.log[h.log.length - 1]).toBe("settled");
  });
});
