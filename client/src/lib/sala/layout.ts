// Where cards go on a room's canvas: pure geometry, no DOM. The relay keeps
// only what the person arranged (`RoomCanvas`); agents that arrived since —
// a worker the principal delegated to while nobody was looking — get a
// place here, under whoever delegated to them, clear of everything else.
import type { RoomAgent, RoomCanvas, RoomCanvasArea } from "@/lib/relay/roomClient";
import { GRID, boundsOf, snap, type Rect } from "@/lib/sala/camera";

export const CARD_W = 264;
export const CARD_W_MAIN = 312;
export const CARD_H = 156;
/** Vertical distance between a card and the ones it delegated. */
export const ROW = 264;
/** Horizontal distance between siblings. */
export const COL = 288;
/** Space an area keeps around its members. */
export const AREA_PAD = 24;
/** The label bar above an area's frame. */
export const AREA_BAR = 32;
const GAP = 12;

export function cardSize(agent: Pick<RoomAgent, "role">): { w: number; h: number } {
  return { w: agent.role === "principal" ? CARD_W_MAIN : CARD_W, h: CARD_H };
}

function overlaps(a: Rect, b: Rect, gap = GAP): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** The elbow that joins a parent's bottom edge to a child's top edge: down,
 * across, down — or around the side when the child is not below the parent. */
export function edgePath(p: Rect, c: Rect): string {
  const r = (v: number): number => Math.round(v * 10) / 10;
  const x1 = r(p.x + p.w / 2);
  const y1 = r(p.y + p.h);
  const x2 = r(c.x + c.w / 2);
  const y2 = r(c.y);
  if (y2 - y1 >= 28) {
    const ym = r(y1 + (y2 - y1) / 2);
    return `M${String(x1)} ${String(y1)}V${String(ym)}H${String(x2)}V${String(y2)}`;
  }
  const ya = r(y1 + 14);
  const yb = r(y2 - 14);
  let xm: number;
  if (c.x > p.x + p.w + 24) xm = r((p.x + p.w + c.x) / 2);
  else if (c.x + c.w < p.x - 24) xm = r((c.x + c.w + p.x) / 2);
  else xm = r(x2 >= x1 ? Math.max(p.x + p.w, c.x + c.w) + 24 : Math.min(p.x, c.x) - 24);
  return `M${String(x1)} ${String(y1)}V${String(ya)}H${String(xm)}V${String(yb)}H${String(x2)}V${String(y2)}`;
}

/** The frame an area draws: around its members' cards with the area's
 * padding, or the rectangle it was stored with when none of them is here. */
export function areaRect(area: RoomCanvasArea, cards: ReadonlyMap<string, Rect>): Rect {
  const rects = (area.members ?? []).flatMap((id) => {
    const rect = cards.get(id);
    return rect ? [rect] : [];
  });
  if (rects.length === 0) return { x: area.x, y: area.y, w: area.width ?? 480, h: area.height ?? 312 };
  const box = boundsOf(rects);
  return { x: box.x - AREA_PAD, y: box.y - AREA_PAD, w: box.w + AREA_PAD * 2, h: box.h + AREA_PAD * 2 };
}

/** The same frame as the shape the relay stores. */
export function storedArea(area: RoomCanvasArea, cards: ReadonlyMap<string, Rect>): RoomCanvasArea {
  const rect = areaRect(area, cards);
  return { ...area, x: rect.x, y: rect.y, width: rect.w, height: rect.h };
}

export function cardRects(agents: readonly RoomAgent[], positions: RoomCanvas["positions"]): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const agent of agents) {
    const at = positions[agent.agentId];
    if (at) out.set(agent.agentId, { x: at.x, y: at.y, ...cardSize(agent) });
  }
  return out;
}

/** The children of each agent, in the order the channel lists them. */
function childrenOf(agents: readonly RoomAgent[]): Map<string, RoomAgent[]> {
  const ids = new Set(agents.map((a) => a.agentId));
  const out = new Map<string, RoomAgent[]>();
  for (const agent of agents) {
    if (agent.parentId === undefined || !ids.has(agent.parentId)) continue;
    const list = out.get(agent.parentId) ?? [];
    list.push(agent);
    out.set(agent.parentId, list);
  }
  return out;
}

/** Parents before children (a child never gets a place before who delegated
 * to it); agents whose parent is not in the room count as roots. */
export function treeOrder(agents: readonly RoomAgent[]): RoomAgent[] {
  const ids = new Set(agents.map((a) => a.agentId));
  const kids = childrenOf(agents);
  const roots = agents.filter((a) => a.parentId === undefined || !ids.has(a.parentId));
  const out: RoomAgent[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.agentId)) continue;
    seen.add(next.agentId);
    out.push(next);
    queue.push(...(kids.get(next.agentId) ?? []));
  }
  return out;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * A place for a new card under `parent`: first free spot on the row below,
 * then the rows after it, scanning sideways from where the siblings start.
 * `obstacles` are cards and area frames to stay clear of.
 */
export function spawnUnder(parent: Rect, siblings: readonly Rect[], size: { w: number; h: number }, obstacles: readonly Rect[]): { x: number; y: number } {
  const baseX = siblings.length > 0 ? Math.min(...siblings.map((s) => s.x)) : parent.x + parent.w / 2 - size.w / 2;
  for (let row = 1; row <= 6; row += 1) {
    const y = snap(parent.y + ROW * row);
    for (let c = 0; c <= siblings.length + 1; c += 1) {
      const spot = { x: snap(baseX + c * COL), y, ...size };
      if (!obstacles.some((o) => overlaps(spot, o))) return { x: spot.x, y: spot.y };
    }
  }
  return { x: snap(baseX), y: snap(parent.y + ROW * 7) };
}

/**
 * The canvas with every agent placed. Positions the person set are kept as
 * they are; an agent with none is put under its parent (a root goes to the
 * right of everything, the first one at the origin). An agent whose `area`
 * names an area joins it (creating it when absent), and one delegated by a
 * member joins the member's area. Pure: returns a new canvas, the same
 * object when nothing was missing.
 */
export function placeAgents(agents: readonly RoomAgent[], canvas: RoomCanvas): RoomCanvas {
  const missing = agents.filter((a) => canvas.positions[a.agentId] === undefined);
  if (missing.length === 0) return canvas;

  const positions = { ...canvas.positions };
  const areas = canvas.areas.map((a) => ({ ...a, members: [...(a.members ?? [])] }));
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const kids = childrenOf(agents);
  const areaOfMember = (id: string): (typeof areas)[number] | undefined => areas.find((a) => a.members.includes(id));
  const rectOf = (agent: RoomAgent): Rect | undefined => {
    const at = positions[agent.agentId];
    return at ? { x: at.x, y: at.y, ...cardSize(agent) } : undefined;
  };

  for (const agent of treeOrder(agents)) {
    if (positions[agent.agentId] !== undefined) continue;
    const size = cardSize(agent);
    const cards = new Map<string, Rect>();
    for (const other of agents) {
      const rect = rectOf(other);
      if (rect) cards.set(other.agentId, rect);
    }
    const own = areaOfMember(agent.agentId);
    const parent = agent.parentId === undefined ? undefined : byId.get(agent.parentId);
    const parentArea = parent ? areaOfMember(parent.agentId) : undefined;
    const labelled = agent.area ? areas.find((a) => normalizeLabel(a.label) === normalizeLabel(agent.area ?? "")) : undefined;
    const home = own ?? labelled ?? (parent?.role === "worker" ? parentArea : undefined);

    const obstacles: Rect[] = [...cards.values()];
    for (const area of areas) {
      if (area === home) continue;
      const frame = areaRect(area, cards);
      obstacles.push({ x: frame.x, y: frame.y - AREA_BAR, w: frame.w, h: frame.h + AREA_BAR });
    }

    const parentRect = parent ? rectOf(parent) : undefined;
    let spot: { x: number; y: number };
    if (parent && parentRect) {
      const siblings = (kids.get(parent.agentId) ?? []).flatMap((s) => {
        const rect = s.agentId === agent.agentId ? undefined : rectOf(s);
        return rect ? [rect] : [];
      });
      spot = spawnUnder(parentRect, siblings, size, obstacles);
    } else if (cards.size === 0) {
      spot = { x: 0, y: 0 };
    } else {
      const box = boundsOf([...cards.values()]);
      spot = { x: snap(box.x + box.w + 48), y: snap(box.y) };
    }
    positions[agent.agentId] = spot;

    if (agent.area && !home) {
      const created = { id: `area-${normalizeLabel(agent.area).replace(/[^a-z0-9]+/g, "-")}-${String(areas.length + 1)}`, label: agent.area, x: spot.x, y: spot.y, members: [agent.agentId] };
      areas.push(created);
    } else if (home && !home.members.includes(agent.agentId)) {
      home.members.push(agent.agentId);
    }
  }

  const cards = cardRects(agents, positions);
  return { ...canvas, positions, areas: areas.map((a) => storedArea(a, cards)) };
}

/** Everything the canvas shows, as one box: cards, area frames with their
 * label bars, and free text. What "fit to screen" and the minimap frame. */
export function worldBounds(cards: readonly Rect[], areas: readonly Rect[], texts: readonly { x: number; y: number; text: string; big?: boolean }[]): Rect {
  const rects: Rect[] = [...cards];
  for (const a of areas) rects.push({ x: a.x, y: a.y - AREA_BAR + 2, w: a.w, h: a.h + AREA_BAR - 2 });
  for (const t of texts) {
    const h = t.big ? 42 : 20;
    rects.push({ x: t.x, y: t.y - h, w: Math.max(60, t.text.length * (t.big ? 19 : 9)), h });
  }
  return boundsOf(rects);
}

export { GRID };
