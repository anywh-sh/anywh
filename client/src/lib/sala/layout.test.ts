import { describe, expect, it } from "vitest";
import type { RoomAgent, RoomCanvas } from "@/lib/relay/roomClient";
import { AREA_PAD, CARD_H, CARD_W, CARD_W_MAIN, areaRect, cardRects, edgePath, placeAgents, spawnUnder, treeOrder, worldBounds } from "@/lib/sala/layout";

function agent(agentId: string, over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId, role: "worker", parentId: "main", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, ...over };
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

  it("lays a grandchild below its own parent", () => {
    const agents = [main, agent("a"), agent("b", { parentId: "a" })];
    const out = placeAgents(agents, empty);
    expect(out.positions.b.y).toBeGreaterThan(out.positions.a.y + CARD_H);
  });

  it("keeps what the person arranged, only adding what is missing", () => {
    const arranged: RoomCanvas = { ...empty, positions: { main: { x: 480, y: 96 }, a: { x: -240, y: 1200 } } };
    const agents = [main, agent("a"), agent("b")];
    const out = placeAgents(agents, arranged);
    expect(out.positions.main).toEqual({ x: 480, y: 96 });
    expect(out.positions.a).toEqual({ x: -240, y: 1200 });
    expect(out.positions.b).toBeDefined();
  });

  it("returns the same canvas when every agent already has a place", () => {
    const done: RoomCanvas = { ...empty, positions: { main: { x: 0, y: 0 }, a: { x: 0, y: 264 } } };
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

  it("lets an agent delegated by a member join the member's area", () => {
    const agents = [main, agent("lead", { area: "Code" }), agent("sub", { parentId: "lead" })];
    const out = placeAgents(agents, empty);
    expect(out.areas[0].members).toContain("sub");
  });

  it("does not pull a principal's direct worker into an area just for its parent", () => {
    const agents = [main, agent("a")];
    expect(placeAgents(agents, { ...empty, areas: [{ id: "x", label: "X", x: 0, y: 0, members: ["main"] }] }).areas[0].members).toEqual(["main"]);
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
      ["a", { x: 0, y: 0, w: 264, h: 156 }],
      ["b", { x: 288, y: 264, w: 264, h: 156 }],
    ]);
    expect(areaRect({ id: "x", label: "", x: 0, y: 0, members: ["a", "b"] }, cards)).toEqual({ x: -AREA_PAD, y: -AREA_PAD, w: 552 + AREA_PAD * 2, h: 420 + AREA_PAD * 2 });
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
    expect(edgePath({ x: 0, y: 0, w: 264, h: 156 }, { x: 288, y: 264, w: 264, h: 156 })).toBe("M132 156V210H420V264");
  });
  it("goes around the side for a child that is not below", () => {
    const d = edgePath({ x: 0, y: 0, w: 264, h: 156 }, { x: 600, y: 100, w: 264, h: 156 });
    expect(d.startsWith("M132 156V170H")).toBe(true);
    expect(d.endsWith("V100")).toBe(true);
  });
});

describe("spawnUnder", () => {
  it("skips a spot an obstacle covers", () => {
    const parent = { x: 0, y: 0, w: 264, h: 156 };
    const free = spawnUnder(parent, [], { w: 264, h: 156 }, []);
    const taken = spawnUnder(parent, [], { w: 264, h: 156 }, [{ x: free.x, y: free.y, w: 264, h: 156 }]);
    expect(taken).not.toEqual(free);
  });
});

describe("worldBounds", () => {
  it("includes the label bar above an area and free text", () => {
    const box = worldBounds([{ x: 0, y: 0, w: 100, h: 100 }], [{ x: 0, y: 200, w: 100, h: 100 }], [{ x: 0, y: -10, text: "Title", big: true }]);
    expect(box.y).toBeLessThan(-10);
    expect(box.y + box.h).toBe(300);
  });
});
