import { describe, expect, it } from "vitest";
import type { RoomAgent, RoomCanvas } from "@/lib/relay/roomClient";
import { AREA_BAR, AREA_ROW_MAX, WRAP_SHIFT, AREA_GAP, AREA_PAD, CARD_H, CARD_W, CARD_W_MAIN, GRID, areaRect, cardRects, edgePath, groupInto, membershipAfterDrop, placeAgents, prunePositions, spawnUnder, subtreeIds, trackDrag, treeOrder, worldBounds } from "@/lib/sala/layout";
import type { Rect } from "@/lib/sala/camera";

function agent(agentId: string, over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId, role: "worker", parentId: "main", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}
const main = agent("main", { role: "principal", parentId: undefined });
const empty: RoomCanvas = { positions: {}, areas: [], texts: [] };

function noOverlap(canvas: RoomCanvas, agents: RoomAgent[]): boolean {
  const rects = [...cardRects(agents, canvas.positions).values()];
  return rects.every((a, i) => rects.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
}

describe("placeAgents", () => {
  it("puts the first agent at the origin and children below it", () => {
    const out = placeAgents([main, agent("a")], empty);
    expect(out.positions.main).toEqual({ x: 0, y: 0 });
    expect(out.positions.a.y).toBeGreaterThan(CARD_H);
  });

  it("centres a lone child under its parent (grid snapped)", () => {
    const out = placeAgents([main, agent("a")], empty);
    const centre = out.positions.main.x + CARD_W_MAIN / 2;
    expect(Math.abs(out.positions.a.x + CARD_W / 2 - centre)).toBeLessThanOrEqual(12);
    expect(out.positions.a.x % 24).toBe(0);
    expect(out.positions.a.y % 24).toBe(0);
  });

  it("never overlaps ten agents, and fans siblings out sideways", () => {
    const agents = [main, ...Array.from({ length: 9 }, (_, i) => agent(`w${String(i)}`))];
    const out = placeAgents(agents, empty);
    expect(Object.keys(out.positions)).toHaveLength(10);
    expect(noOverlap(out, agents)).toBe(true);
  });

  it("leaves the link's elbow above the label bar of the area its child is in, so the link never runs through the name", () => {
    const agents = [main, agent("a", { area: "Design" })];
    const out = placeAgents(agents, empty);
    const cards = cardRects(agents, out.positions);
    const parent = cards.get("main")!;
    const child = cards.get("a")!;
    const elbow = parent.y + parent.h + (child.y - (parent.y + parent.h)) / 2;
    const barTop = areaRect(out.areas[0], cards).y - AREA_BAR;
    expect(elbow).toBeLessThan(barTop);
  });

  it("lays a grandchild below its own parent", () => {
    const agents = [main, agent("a"), agent("b", { parentId: "a" })];
    const out = placeAgents(agents, empty);
    expect(out.positions.b.y).toBeGreaterThan(out.positions.a.y + CARD_H);
  });

  it("keeps what the person arranged, only adding what is missing", () => {
    const arranged: RoomCanvas = { ...empty, manual: true, positions: { main: { x: 480, y: 96 }, a: { x: -240, y: 1200 } } };
    const agents = [main, agent("a"), agent("b")];
    const out = placeAgents(agents, arranged);
    expect(out.positions.main).toEqual({ x: 480, y: 96 });
    expect(out.positions.a).toEqual({ x: -240, y: 1200 });
    expect(out.positions.b).toBeDefined();
  });

  it("returns the same canvas when every agent already has a place", () => {
    const done: RoomCanvas = { ...empty, manual: true, positions: { main: { x: 0, y: 0 }, a: { x: 0, y: 264 } } };
    expect(placeAgents([main, agent("a")], done)).toBe(done);
  });

  it("places a root with no parent to the right of everything", () => {
    const loose = agent("loose", { parentId: undefined });
    const out = placeAgents([main, loose], { ...empty, positions: { main: { x: 0, y: 0 } } });
    expect(out.positions.loose.x).toBeGreaterThanOrEqual(CARD_W_MAIN);
  });

  it("treats an agent whose parent left the room as a root", () => {
    const out = placeAgents([main, agent("orphan", { parentId: "gone" })], empty);
    expect(out.positions.orphan).toBeDefined();
  });

  it("creates the area an agent names, and puts its siblings in it", () => {
    const agents = [main, agent("a", { area: "Design" }), agent("b", { area: "design" })];
    const out = placeAgents(agents, empty);
    expect(out.areas).toHaveLength(1);
    expect(out.areas[0].label).toBe("Design");
    expect(out.areas[0].members).toEqual(["a", "b"]);
  });

  it("keeps an area's id and label within what the relay accepts, whatever the agent called it", () => {
    const long = "A very long name for an area ".repeat(20);
    const out = placeAgents([main, agent("a", { area: long })], empty);
    expect(out.areas[0].id.length).toBeLessThanOrEqual(128);
    expect(out.areas[0].label.length).toBeLessThanOrEqual(200);
  });

  it("lets an agent delegated by a member join the member's area", () => {
    const agents = [main, agent("lead", { area: "Code" }), agent("sub", { parentId: "lead" })];
    const out = placeAgents(agents, empty);
    expect(out.areas[0].members).toContain("sub");
  });

  it("does not pull a principal's direct worker into an area just for its parent", () => {
    const agents = [main, agent("a")];
    expect(placeAgents(agents, { ...empty, manual: true, areas: [{ id: "x", label: "X", x: 0, y: 0, members: ["main"] }] }).areas[0].members).toEqual(["main"]);
  });

  it("keeps new cards out of another area's frame", () => {
    const agents = [main, agent("a", { area: "Left" }), agent("b", { area: "Right" })];
    const out = placeAgents(agents, empty);
    const cards = cardRects(agents, out.positions);
    const [left, right] = out.areas;
    const lr = areaRect(left, cards);
    const rr = areaRect(right, cards);
    expect(lr.x + lr.w <= rr.x || rr.x + rr.w <= lr.x || lr.y + lr.h <= rr.y || rr.y + rr.h <= lr.y).toBe(true);
  });
});

describe("placeAgents with areas that grow", () => {
  function frames(out: RoomCanvas, agents: RoomAgent[]): Rect[] {
    const cards = cardRects(agents, out.positions);
    return out.areas.map((a) => areaRect(a, cards));
  }
  const apart = (a: Rect, b: Rect): boolean => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

  it("never lets a new member stretch its area over another area, however the agents arrive", () => {
    const agents = [
      main,
      agent("lead", { area: "Design" }),
      agent("other", { area: "Code" }),
      agent("deep1", { parentId: "lead" }),
      agent("deep2", { parentId: "deep1" }),
      agent("deep3", { parentId: "deep2" }),
    ];
    let canvas = empty;
    for (let i = 1; i <= agents.length; i += 1) canvas = placeAgents(agents.slice(0, i), canvas);
    const [design, code] = frames(canvas, agents);
    expect(apart(design, code)).toBe(true);
    expect(noOverlap(canvas, agents)).toBe(true);
  });

  it("leaves room between two areas for their label bars", () => {
    const agents = [main, agent("a", { area: "Design" }), agent("b", { area: "Research" }), agent("c", { area: "Code" })];
    let canvas = empty;
    for (let i = 1; i <= agents.length; i += 1) canvas = placeAgents(agents.slice(0, i), canvas);
    const rects = frames(canvas, agents);
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
        const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
        expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(AREA_GAP - 1);
      }
    }
  });

  it("does the same when every agent arrives at once", () => {
    const agents = [main, agent("a", { area: "Left" }), agent("b", { area: "Right" }), agent("c", { parentId: "a" }), agent("d", { parentId: "b" }), agent("e", { parentId: "c" })];
    const canvas = placeAgents(agents, empty);
    const [left, right] = frames(canvas, agents);
    expect(apart(left, right)).toBe(true);
  });
});

describe("prunePositions", () => {
  const many = (n: number): Record<string, { x: number; y: number }> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${String(i)}`, { x: i, y: i }]));
  it("keeps everything while there is room, so a removed agent can come back to its place", () => {
    const positions = many(10);
    expect(prunePositions(positions, new Set(["a1"]))).toBe(positions);
  });
  it("lets go of the places of agents that are gone once the canvas nears the relay's limit", () => {
    const kept = prunePositions(many(450), new Set(["a1", "a2"]));
    expect(Object.keys(kept)).toEqual(["a1", "a2"]);
  });
});

describe("treeOrder", () => {
  it("lists parents before children", () => {
    const order = treeOrder([agent("c", { parentId: "b" }), agent("b", { parentId: "main" }), main]).map((a) => a.agentId);
    expect(order.indexOf("main")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });
  it("does not loop on a cycle", () => {
    const order = treeOrder([agent("x", { parentId: "y" }), agent("y", { parentId: "x" })]);
    expect(order.length).toBeLessThanOrEqual(2);
  });
});

describe("areaRect", () => {
  it("wraps its members with the area padding", () => {
    const cards = new Map([
      ["a", { x: 0, y: 0, w: 264, h: 145 }],
      ["b", { x: 288, y: 264, w: 264, h: 145 }],
    ]);
    expect(areaRect({ id: "x", label: "", x: 0, y: 0, members: ["a", "b"] }, cards)).toEqual({ x: -AREA_PAD, y: -AREA_PAD, w: 552 + AREA_PAD * 2, h: 409 + AREA_PAD * 2 });
  });
  it("stretches when a member moves away", () => {
    const area = { id: "x", label: "", x: 0, y: 0, members: ["a", "b"] };
    const near = areaRect(area, new Map([["a", { x: 0, y: 0, w: 10, h: 10 }], ["b", { x: 20, y: 0, w: 10, h: 10 }]]));
    const far = areaRect(area, new Map([["a", { x: 0, y: 0, w: 10, h: 10 }], ["b", { x: 500, y: 0, w: 10, h: 10 }]]));
    expect(far.w).toBeGreaterThan(near.w);
  });
  it("ignores members that are not on the canvas, and falls back to what it stored", () => {
    expect(areaRect({ id: "x", label: "", x: 5, y: 6, width: 100, height: 80, members: ["ghost"] }, new Map())).toEqual({ x: 5, y: 6, w: 100, h: 80 });
  });
});

describe("edgePath", () => {
  it("goes down, across, down for a child below its parent", () => {
    expect(edgePath({ x: 0, y: 0, w: 264, h: 145 }, { x: 288, y: 264, w: 264, h: 145 })).toBe("M132 145V169H420V264");
  });
  it("runs across the middle when the rows are close", () => {
    expect(edgePath({ x: 0, y: 0, w: 264, h: 145 }, { x: 288, y: 200, w: 264, h: 145 })).toBe("M132 145V172.5H420V200");
  });
  it("goes around the side for a child that is not below", () => {
    const d = edgePath({ x: 0, y: 0, w: 264, h: 145 }, { x: 600, y: 100, w: 264, h: 145 });
    expect(d.startsWith("M132 145V159H")).toBe(true);
    expect(d.endsWith("V100")).toBe(true);
  });
});

describe("spawnUnder", () => {
  it("skips a spot an obstacle covers", () => {
    const parent = { x: 0, y: 0, w: 264, h: 145 };
    const free = spawnUnder(parent, [], { w: 264, h: 145 }, [])!;
    const taken = spawnUnder(parent, [], { w: 264, h: 145 }, [{ x: free.x, y: free.y, w: 264, h: 145 }]);
    expect(taken).toBeDefined();
    expect(taken).not.toEqual(free);
  });

  it("gives up (undefined) when no spot satisfies the extra condition", () => {
    expect(spawnUnder({ x: 0, y: 0, w: 264, h: 145 }, [], { w: 264, h: 145 }, [], () => false)).toBeUndefined();
  });
});

describe("worldBounds", () => {
  it("includes the label bar above an area and free text", () => {
    const box = worldBounds([{ x: 0, y: 0, w: 100, h: 100 }], [{ x: 0, y: 200, w: 100, h: 100 }], [{ x: 0, y: -10, text: "Title", big: true }]);
    expect(box.y).toBeLessThan(-10);
    expect(box.y + box.h).toBe(300);
  });
});

describe("dragging between areas", () => {
  const box = (x: number, y: number): Rect => ({ x, y, w: 264, h: 145 });
  const areas = [
    { id: "left", label: "Left", x: 0, y: 0, members: ["a", "b"] },
    { id: "right", label: "Right", x: 1000, y: 0, members: ["c"] },
  ];
  const base = (): Map<string, Rect> =>
    new Map([
      ["a", box(0, 0)],
      ["b", box(288, 0)],
      ["c", box(1000, 0)],
    ]);

  it("stretches its own area while it stays near the others", () => {
    const cards = base();
    cards.set("b", box(500, 0));
    expect(trackDrag(areas, cards, "b").leaving).toBe(false);
    expect(membershipAfterDrop(areas, cards, "b").areas[0].members).toEqual(["a", "b"]);
  });

  it("leaves once it is more than a card away from the rest", () => {
    const cards = base();
    cards.set("b", box(288 + 900, 700));
    expect(trackDrag(areas, cards, "b").leaving).toBe(true);
    const after = membershipAfterDrop(areas, cards, "b");
    expect(after.areas[0].members).toEqual(["a"]);
    expect(after.left).toBe("left");
    expect(after.entered).toBeUndefined();
  });

  it("changes area when dropped over another, however close it still is", () => {
    const cards = base();
    cards.set("b", box(1010, 10));
    const track = trackDrag(areas, cards, "b");
    expect(track.target?.id).toBe("right");
    const after = membershipAfterDrop(areas, cards, "b");
    expect(after.areas[0].members).toEqual(["a"]);
    expect(after.areas[1].members).toEqual(["c", "b"]);
    expect(after.entered).toBe("right");
  });

  it("does not let the last member of an area leave it by walking away", () => {
    const cards = base();
    cards.set("c", box(5000, 5000));
    expect(trackDrag(areas, cards, "c").leaving).toBe(false);
  });

  it("is a no-op for a card with no area", () => {
    const cards = base();
    cards.set("z", box(4000, 4000));
    expect(membershipAfterDrop(areas, cards, "z").areas).toEqual(areas);
  });
});

describe("groupInto and subtreeIds", () => {
  it("takes the cards out of their old areas", () => {
    const next = groupInto([{ id: "old", label: "Old", x: 0, y: 0, members: ["a", "b"] }], ["a"], { x: 0, y: 0, w: 10, h: 10 }, "new");
    expect(next[0].members).toEqual(["b"]);
    expect(next[1]).toMatchObject({ id: "new", members: ["a"], label: "" });
  });
  it("lists an agent and all it delegated, deep", () => {
    const agents = [main, agent("a"), agent("b", { parentId: "a" }), agent("c", { parentId: "b" }), agent("d")];
    expect(subtreeIds(agents, "a").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("tidyLayout", () => {
  const cardsOf = (agents: RoomAgent[], out: RoomCanvas) => cardRects(agents, out.positions);

  it("centres the principal over the cards it delegated to", () => {
    const agents = [main, agent("a"), agent("b"), agent("c")];
    const cards = cardsOf(agents, placeAgents(agents, empty));
    const kids = ["a", "b", "c"].map((id) => cards.get(id)!);
    const left = Math.min(...kids.map((k) => k.x + k.w / 2));
    const right = Math.max(...kids.map((k) => k.x + k.w / 2));
    const mid = cards.get("main")!.x + CARD_W_MAIN / 2;
    expect(Math.abs(mid - (left + right) / 2)).toBeLessThanOrEqual(12);
  });

  it("keeps a worker delegated by an area member inside that area's frame", () => {
    const agents = [main, agent("a", { area: "Design" }), agent("b", { area: "Design" }), agent("c", { parentId: "a" }), agent("d", { area: "Code" })];
    const out = placeAgents(agents, empty);
    const cards = cardsOf(agents, out);
    const design = out.areas.find((a) => a.label === "Design")!;
    expect(design.members).toEqual(["a", "b", "c"]);
    const frame = areaRect(design, cards);
    for (const id of ["a", "b", "c"]) {
      const r = cards.get(id)!;
      expect(r.x).toBeGreaterThanOrEqual(frame.x);
      expect(r.x + r.w).toBeLessThanOrEqual(frame.x + frame.w);
      expect(r.y + r.h).toBeLessThanOrEqual(frame.y + frame.h);
    }
    const code = areaRect(out.areas.find((a) => a.label === "Code")!, cards);
    expect(frame.x + frame.w <= code.x || code.x + code.w <= frame.x).toBe(true);
  });

  it("is stable: the same agents give the same canvas object", () => {
    const agents = [main, agent("a", { area: "Design" }), agent("b")];
    const once = placeAgents(agents, empty);
    expect(placeAgents(agents, once)).toBe(once);
  });

  it("lays the rows out on the grid and no two cards overlap", () => {
    const agents = [main, agent("a", { area: "X" }), agent("b", { area: "X" }), agent("c", { area: "Y" }), agent("d", { parentId: "a" }), agent("e", { parentId: "a" }), agent("f", { parentId: "c" })];
    const out = placeAgents(agents, empty);
    const rects = [...cardsOf(agents, out).values()];
    for (const [i, r] of rects.entries()) {
      expect(r.x % GRID).toBe(0);
      for (const o of rects.slice(i + 1)) expect(r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h).toBe(false);
    }
  });
});

describe("rows of an area", () => {
  const rowsOf = (agents: RoomAgent[], out: RoomCanvas, ids: string[]) => {
    const cards = cardRects(agents, out.positions);
    const byY = new Map<number, Rect[]>();
    for (const id of ids) byY.set(cards.get(id)!.y, [...(byY.get(cards.get(id)!.y) ?? []), cards.get(id)!]);
    return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r.sort((a, b) => a.x - b.x));
  };
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const agents = [main, ...ids.map((id) => agent(id, { area: "Design" }))];

  it("tidies at most three cards to a row, the next row starting a little to the left", () => {
    const out = placeAgents(agents, empty);
    const rows = rowsOf(agents, out, ids);
    expect(rows.map((r) => r.length)).toEqual([3, 3, 1]);
    expect(rows[0].length).toBeLessThanOrEqual(AREA_ROW_MAX);
    expect(rows[1][0].x).toBe(rows[0][0].x - WRAP_SHIFT);
    expect(noOverlap(out, agents)).toBe(true);
    const design = areaRect(out.areas[0], cardRects(agents, out.positions));
    for (const r of rows.flat()) expect(r.x >= design.x && r.x + r.w <= design.x + design.w).toBe(true);
  });

  it("does the same when the cards of an arranged canvas arrive one at a time", () => {
    let canvas: RoomCanvas = { ...placeAgents([main, agent("a", { area: "Design" })], empty), manual: true };
    for (const [i, id] of ids.slice(1).entries()) {
      canvas = placeAgents([main, ...ids.slice(0, i + 2).map((x) => agent(x, { area: "Design" }))], canvas);
      expect(canvas.positions[id]).toBeDefined();
    }
    const rows = rowsOf(agents, canvas, ids);
    expect(rows.map((r) => r.length)).toEqual([3, 3, 1]);
    expect(rows[1][0].x).toBe(rows[0][0].x - WRAP_SHIFT);
    expect(noOverlap(canvas, agents)).toBe(true);
  });
});
