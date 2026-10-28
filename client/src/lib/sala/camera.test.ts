import { describe, expect, it } from "vitest";
import {
  boundsOf,
  cameraShows,
  centerCamera,
  clampZoom,
  fitCamera,
  gridLayer,
  gridNeedsRedraw,
  layoutZoom,
  MIN_LAYOUT_ZOOM,
  minimapMap,
  minimapToWorld,
  minimapView,
  nextZoomLevel,
  planeStyle,
  revealCamera,
  screenToWorld,
  snap,
  wheelZoom,
  zoomAround,
} from "@/lib/sala/camera";

describe("zoomAround", () => {
  it("keeps the world point under the cursor still", () => {
    const cam = { x: 100, y: -40, z: 1 };
    const before = screenToWorld(cam, 300, 200);
    const zoomed = zoomAround(cam, 1.5, 300, 200);
    const after = screenToWorld(zoomed, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.z).toBe(1.5);
  });

  it("never leaves the 25%-200% range", () => {
    expect(zoomAround({ x: 0, y: 0, z: 1 }, 9, 0, 0).z).toBe(2);
    expect(zoomAround({ x: 0, y: 0, z: 1 }, 0.01, 0, 0).z).toBe(0.25);
    expect(clampZoom(1.2)).toBe(1.2);
  });
});

describe("zoom steps and wheel", () => {
  it("walks the ladder both ways and stops at its ends", () => {
    expect(nextZoomLevel(1, 1)).toBe(1.25);
    expect(nextZoomLevel(1, -1)).toBe(0.8);
    expect(nextZoomLevel(0.49, 1)).toBe(0.5);
    expect(nextZoomLevel(2, 1)).toBeUndefined();
    expect(nextZoomLevel(0.25, -1)).toBeUndefined();
  });

  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelZoom(1, -100, false)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100, false)).toBeLessThan(1);
    expect(wheelZoom(1, -1e6, true)).toBe(2);
  });
});

describe("fitCamera", () => {
  const vp = { w: 1000, h: 700 };

  it("shows all of the box, centred", () => {
    const box = { x: 500, y: 200, w: 2000, h: 1000 };
    const cam = fitCamera(box, vp);
    expect(cam.z).toBeLessThan(1);
    expect(box.x * cam.z + cam.x).toBeGreaterThanOrEqual(0);
    expect((box.x + box.w) * cam.z + cam.x).toBeLessThanOrEqual(vp.w);
    expect((box.y + box.h) * cam.z + cam.y).toBeLessThanOrEqual(vp.h);
  });

  it("does not blow a lone card up past 100%", () => {
    expect(fitCamera({ x: 0, y: 0, w: 264, h: 145 }, vp).z).toBe(1);
  });

  it("does not shrink past 30% however large the room", () => {
    expect(fitCamera({ x: 0, y: 0, w: 50000, h: 50000 }, vp).z).toBe(0.3);
  });
});

describe("revealCamera", () => {
  const vp = { w: 1000, h: 700 };

  it("leaves the camera alone for a rect already in view", () => {
    const cam = { x: 0, y: 0, z: 1 };
    expect(revealCamera(cam, { x: 400, y: 300, w: 200, h: 100 }, vp)).toBe(cam);
  });

  it("moves just far enough to bring one in from the right", () => {
    const next = revealCamera({ x: 0, y: 0, z: 1 }, { x: 1200, y: 300, w: 200, h: 100 }, vp);
    expect(next.z).toBe(1);
    expect(next.x).toBeLessThan(0);
    expect(1400 + next.x).toBeLessThanOrEqual(vp.w);
  });
});

describe("cameraShows", () => {
  const content = { x: 0, y: 0, w: 1000, h: 600 };
  it("is true when the viewport overlaps the content, even a little", () => {
    expect(cameraShows({ x: 0, y: 0, z: 1 }, content, { w: 800, h: 600 })).toBe(true);
    expect(cameraShows({ x: -950, y: 0, z: 1 }, content, { w: 800, h: 600 })).toBe(true);
  });
  it("is false when it looks at empty canvas", () => {
    expect(cameraShows({ x: -5000, y: 0, z: 1 }, content, { w: 800, h: 600 })).toBe(false);
    expect(cameraShows({ x: 0, y: 4000, z: 1 }, content, { w: 800, h: 600 })).toBe(false);
  });
  it("accounts for zoom", () => {
    // The same pixel offset is a different place in the world at another zoom.
    expect(cameraShows({ x: -400, y: 0, z: 0.5 }, content, { w: 800, h: 600 })).toBe(true);
    expect(cameraShows({ x: -3000, y: 0, z: 2 }, content, { w: 800, h: 600 })).toBe(false);
  });
});

describe("centerCamera", () => {
  it("puts the point in the middle of the viewport", () => {
    const cam = centerCamera({ x: 0, y: 0, z: 0.5 }, 400, 200, { w: 1000, h: 600 });
    expect(400 * cam.z + cam.x).toBe(500);
    expect(200 * cam.z + cam.y).toBe(300);
  });
});

describe("boundsOf and snap", () => {
  it("takes the union of rects", () => {
    expect(boundsOf([{ x: 10, y: 10, w: 10, h: 10 }, { x: 50, y: -20, w: 5, h: 5 }])).toEqual({ x: 10, y: -20, w: 45, h: 40 });
  });
  it("has a default for an empty room", () => {
    expect(boundsOf([]).w).toBeGreaterThan(0);
  });
  it("snaps to the 24px grid", () => {
    expect(snap(35)).toBe(24);
    expect(snap(37)).toBe(48);
    expect(snap(-13)).toBe(-24);
  });
});

describe("minimap", () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 500 };
  const map = minimapMap(bounds);

  it("fits the padded world inside 136x84", () => {
    const rect = { x: 0, y: 0, w: 1000, h: 500 };
    const m = { x: (rect.x - map.ox) * map.s + map.offX, w: rect.w * map.s };
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.w).toBeLessThanOrEqual(136);
  });

  it("round-trips a point through the minimap", () => {
    const view = minimapView(map, { x: 0, y: 0, z: 1 }, { w: 800, h: 600 });
    const world = minimapToWorld(map, view.x, view.y);
    expect(world.x).toBeCloseTo(0, 6);
    expect(world.y).toBeCloseTo(0, 6);
  });

  it("shows a larger slice of the world when zoomed out", () => {
    const near = minimapView(map, { x: 0, y: 0, z: 1 }, { w: 800, h: 600 });
    const far = minimapView(map, { x: 0, y: 0, z: 0.5 }, { w: 800, h: 600 });
    expect(far.w).toBeCloseTo(near.w * 2, 6);
  });
});

describe("gridLayer", () => {
  const vp = { w: 1200, h: 800 };

  it("pans by changing only the transform, never the raster", () => {
    const a = gridLayer({ x: 0, y: 0, z: 1 }, 1, vp);
    const b = gridLayer({ x: 137.5, y: -91, z: 1 }, 1, vp);
    expect(b.key).toBe(a.key);
    expect(b.backgroundImage).toBe(a.backgroundImage);
    expect(b.transform).not.toBe(a.transform);
  });

  it("wraps the offset inside one big cell so the layer never runs out", () => {
    const layer = gridLayer({ x: 100000, y: -100000, z: 1 }, 1, vp);
    const [ox, oy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(layer.transform)!.slice(1).map(Number);
    expect(ox).toBeLessThanOrEqual(0);
    expect(ox).toBeGreaterThan(-72 * 1.001);
    expect(oy).toBeLessThanOrEqual(0);
    expect(oy).toBeGreaterThan(-72 * 1.001);
  });

  it("draws the dots in the middle of the cells, not on the lines", () => {
    // A dot tile the size of a cell, drawn from its centre, never lines up
    // with a line at a multiple of three cells.
    const layer = gridLayer({ x: 0, y: 0, z: 1 }, 1, vp);
    expect(layer.backgroundSize.split(", ")[0]).toBe("24.000px 24.000px");
    expect(layer.backgroundSize.split(", ")[1]).toBe("72.000px 72.000px");
  });

  it("asks for a redraw only once a zoom has stretched the raster far", () => {
    expect(gridNeedsRedraw(1.1, 1)).toBe(false);
    expect(gridNeedsRedraw(1.5, 1)).toBe(true);
    expect(gridNeedsRedraw(0.7, 1)).toBe(true);
  });

  it("fades the dots out when cells get too small to read", () => {
    const small = gridLayer({ x: 0, y: 0, z: 0.25 }, 0.25, vp).backgroundImage;
    expect(small).toContain("radial-gradient(circle, color-mix(in srgb, var(--canvas-grid) 0.000%, transparent)");
  });

  it("takes its color from the theme, never a literal", () => {
    // A literal warm white here is what made the grid vanish on every light
    // theme: the color has to come from `--canvas-grid`.
    const image = gridLayer({ x: 0, y: 0, z: 1 }, 1, vp).backgroundImage;
    expect(image).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(image.match(/var\(--canvas-grid\)/g)).toHaveLength(3);
  });
});

describe("planeStyle", () => {
  // A plane scaled by a transform is painted soft by WebKit as soon as it gets
  // a compositing layer (a bitmap of its unscaled size, stretched): at rest,
  // the scale has to be the CSS zoom, never a transform.
  it("carries the whole scale as the zoom at rest, at every zoom it is laid out at", () => {
    for (const z of [MIN_LAYOUT_ZOOM, 1, 1.25, 1.5, 2, 1.7342]) {
      const s = planeStyle({ x: 10, y: 20, z }, layoutZoom(z), true, 1);
      expect(s).toEqual({ zoom: String(z), transform: "translate(10px, 20px)" });
    }
  });

  it("snaps the offset to device pixels at rest, and not while a zoom is in flight", () => {
    expect(planeStyle({ x: 10.37, y: -3.81, z: 1 }, 1, true, 1).transform).toBe("translate(10px, -4px)");
    expect(planeStyle({ x: 10.37, y: -3.81, z: 1 }, 1, true, 2).transform).toBe("translate(10.5px, -4px)");
    expect(planeStyle({ x: 10.37, y: -3.81, z: 1.2 }, 1, false, 1).transform).toBe("translate(10.37px, -3.81px) scale(1.20000)");
  });

  it("is laid out no smaller than WebKit lets text shrink, and scaled down from there", () => {
    expect(layoutZoom(0.5)).toBe(MIN_LAYOUT_ZOOM);
    expect(layoutZoom(1.5)).toBe(1.5);
    const s = planeStyle({ x: 0, y: 0, z: 0.45 }, layoutZoom(0.45), true, 1);
    expect(s).toEqual({ zoom: String(MIN_LAYOUT_ZOOM), transform: "translate(0px, 0px) scale(0.50000)" });
  });
});
