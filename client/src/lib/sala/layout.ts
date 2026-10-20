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
export const ROW = 288;
/** Horizontal distance between siblings. */
export const COL = 288;
/** Space an area keeps around its members. */
export const AREA_PAD = 24;
/** The label bar above an area's frame. */
export const AREA_BAR = 32;
/** The least space between two areas' frames. */
export const AREA_GAP = 96;
const GAP = 12;

export function cardSize(agent: Pick<RoomAgent, "role">): { w: number; h: number } {
  return { w: agent.role === "principal" ? CARD_W_MAIN : CARD_W, h: CARD_H };
}

function overlaps(a: Rect, b: Rect, gap = GAP): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** How far under its parent the run across to the children is drawn when
 * there is room: close to the parent, so it stays clear of the area labels
 * that sit just above the children's frames. */
const BUS_DROP = 24;

/** The elbow that joins a parent's bottom edge to a child's top edge: down,
 * across, down — or around the side when the child is not below the parent. */
export function edgePath(p: Rect, c: Rect): string {
  const r = (v: number): number => Math.round(v * 10) / 10;
  const x1 = r(p.x + p.w / 2);
  const y1 = r(p.y + p.h);
  const x2 = r(c.x + c.w / 2);
  const y2 = r(c.y);
  if (y2 - y1 >= 28) {
    const ym = r(y2 - y1 >= 72 ? y1 + BUS_DROP : y1 + (y2 - y1) / 2);
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
export function spawnUnder(
  parent: Rect,
  siblings: readonly Rect[],
  size: { w: number; h: number },
  obstacles: readonly Rect[],
  /** A further condition a spot must meet (its area's frame staying clear of others). */
  accept: (spot: Rect) => boolean = () => true,
): { x: number; y: number } | undefined {
  const baseX = siblings.length > 0 ? Math.min(...siblings.map((s) => s.x)) : parent.x + parent.w / 2 - size.w / 2;
  const centre = parent.x + parent.w / 2 - size.w / 2;
  for (let row = 1; row <= 6; row += 1) {
    const y = snap(parent.y + ROW * row);
    const free = (x: number): { x: number; y: number } | undefined => {
      const spot = { x: snap(x), y, ...size };
      return !obstacles.some((o) => overlaps(spot, o)) && accept(spot) ? { x: spot.x, y: spot.y } : undefined;
    }
    // First the siblings' own sequence, so a row fills left to right ...
    for (let c = 0; c <= siblings.length + 1; c += 1) {
      const found = free(baseX + c * COL);
      if (found) return found;
    }
    // ... then the gaps beside whatever is in the way, nearest to straight
    // under the parent first.
    const band = { x: -Infinity, y, w: Infinity, h: size.h };
    const edges = obstacles
      .filter((o) => o.y < band.y + band.h + GAP && o.y + o.h + GAP > band.y)
      .flatMap((o) => [o.x + o.w + GAP, o.x - size.w - GAP])
      .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
    for (const x of edges) {
      const found = free(x);
      if (found) return found;
    }
  }
  return undefined;
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
  // A canvas nobody has arranged by hand is laid out as a whole each time,
  // so the principal stays centred over whatever it delegated; once the
  // person touches anything, only the newcomers are placed.
  if (canvas.manual !== true) return tidyLayout(agents, canvas);
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
    // The tree had no room near the parent that kept the area clear of the
    // others: the card sits apart, outside the area, rather than stretching
    // the area across the canvas.
    let apart = false;
    if (parent && parentRect) {
      const siblings = (kids.get(parent.agentId) ?? []).flatMap((s) => {
        const rect = s.agentId === agent.agentId ? undefined : rectOf(s);
        return rect ? [rect] : [];
      });
      // An agent that names an area nobody has used yet starts one: its frame
      // must fit around it just the same.
      const growing = home ?? (agent.area ? { members: [] as string[] } : undefined);
      const near = spawnUnder(parentRect, siblings, size, obstacles, (candidate) => !growing || areaStaysClear(growing, candidate, cards, areas));
      spot = near ?? farFromEverything(cards, snap(parentRect.y + ROW));
      apart = near === undefined;
    } else if (cards.size === 0) {
      spot = { x: 0, y: 0 };
    } else {
      const box = boundsOf([...cards.values()]);
      spot = { x: snap(box.x + box.w + 48), y: snap(box.y) };
    }
    positions[agent.agentId] = spot;

    if (agent.area && !home && !apart) {
      // The id is kept short: the relay refuses a canvas with an id past 128
      // characters, and an area's name can be as long as the agent made it.
      const slug = normalizeLabel(agent.area).replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const created = { id: `area-${slug}-${String(areas.length + 1)}`, label: agent.area.slice(0, 200), x: spot.x, y: spot.y, members: [agent.agentId] };
      areas.push(created);
    } else if (home && !apart && !home.members.includes(agent.agentId)) {
      home.members.push(agent.agentId);
    }
  }

  const cards = cardRects(agents, positions);
  return { ...canvas, positions, areas: areas.map((a) => storedArea(a, cards)) };
}

/** Gap between two cards side by side in the same group, and between a card
 * and a neighbour that sits in another area (whose frame needs the room). */
const SIBLING_GAP = 24;
const AREA_SIBLING_GAP = AREA_GAP + AREA_PAD * 2;

interface Placed {
  id: string;
  /** Centre of the card, relative to the subtree's root. */
  cx: number;
  y: number;
}

interface SubtreeLayout {
  cards: Placed[];
  minX: number;
  maxX: number;
}

/** The area label an agent belongs to in a tidy layout: the one it names, or
 * its parent worker's. */
function tidyAreaLabels(agents: readonly RoomAgent[]): Map<string, string> {
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const out = new Map<string, string>();
  for (const agent of treeOrder(agents)) {
    const own = agent.area?.trim();
    const parent = agent.parentId === undefined ? undefined : byId.get(agent.parentId);
    const label = own ? own : parent?.role === "worker" ? out.get(parent.agentId) : undefined;
    if (label) out.set(agent.agentId, label);
  }
  return out;
}

/**
 * Lays every agent out as a tree: each parent centred over the cards it
 * delegated to, siblings of one area side by side and apart from the next
 * area's, one row per level. Areas follow the agents (the label an agent
 * names, inherited by what its members delegate). Pure; returns the same
 * canvas when nothing would move.
 */
export function tidyLayout(agents: readonly RoomAgent[], canvas: RoomCanvas): RoomCanvas {
  if (agents.length === 0) return canvas;
  const ids = new Set(agents.map((a) => a.agentId));
  const kids = childrenOf(agents);
  const labels = tidyAreaLabels(agents);
  const key = (id: string): string => normalizeLabel(labels.get(id) ?? "");
  const byId = new Map(agents.map((a) => [a.agentId, a]));

  const layout = (agent: RoomAgent, seen: Set<string>): SubtreeLayout => {
    const { w } = cardSize(agent);
    seen.add(agent.agentId);
    // Members of one area stay together, in the order the channel listed them.
    const order: string[] = [];
    for (const kid of kids.get(agent.agentId) ?? []) if (!order.includes(key(kid.agentId))) order.push(key(kid.agentId));
    const children = (kids.get(agent.agentId) ?? []).filter((k) => !seen.has(k.agentId)).sort((a, b) => order.indexOf(key(a.agentId)) - order.indexOf(key(b.agentId)));
    if (children.length === 0) return { cards: [{ id: agent.agentId, cx: 0, y: 0 }], minX: -w / 2, maxX: w / 2 };
    const parts = children.map((kid) => ({ kid, sub: layout(kid, seen) }));
    let cursor = 0;
    const shifted: { id: string; cx: number; y: number }[] = [];
    const roots: number[] = [];
    let previous: string | undefined;
    for (const { kid, sub } of parts) {
      const gap = previous === undefined ? 0 : key(kid.agentId) === previous && previous !== "" ? SIBLING_GAP : previous === "" && key(kid.agentId) === "" ? SIBLING_GAP : AREA_SIBLING_GAP;
      cursor += gap;
      const offset = cursor - sub.minX;
      for (const card of sub.cards) shifted.push({ id: card.id, cx: card.cx + offset, y: card.y + ROW });
      roots.push(offset);
      cursor = offset + sub.maxX;
      previous = key(kid.agentId);
    }
    const centre = (roots[0] + roots[roots.length - 1]) / 2;
    const cards: Placed[] = [{ id: agent.agentId, cx: centre, y: 0 }, ...shifted];
    return { cards, minX: Math.min(centre - w / 2, ...parts.map((p, i) => roots[i] + p.sub.minX)), maxX: Math.max(centre + w / 2, ...parts.map((p, i) => roots[i] + p.sub.maxX)) };
  };

  const seen = new Set<string>();
  const roots = agents.filter((a) => a.parentId === undefined || !ids.has(a.parentId));
  let cursor = 0;
  const positions: RoomCanvas["positions"] = {};
  for (const root of roots) {
    const sub = layout(root, seen);
    const offset = cursor - sub.minX;
    for (const card of sub.cards) {
      const agent = byId.get(card.id)!;
      const { w } = cardSize(agent);
      positions[card.id] = { x: snap(card.cx + offset - w / 2), y: card.y };
    }
    cursor = offset + sub.maxX + AREA_SIBLING_GAP;
  }

  // Areas by label, reusing the ones that already exist for it.
  const areas: RoomCanvasArea[] = [];
  const existing = new Map(canvas.areas.map((a) => [normalizeLabel(a.label), a]));
  for (const agent of treeOrder(agents)) {
    const label = labels.get(agent.agentId);
    if (!label) continue;
    let area = areas.find((a) => normalizeLabel(a.label) === normalizeLabel(label));
    if (!area) {
      const kept = existing.get(normalizeLabel(label));
      const slug = normalizeLabel(label).replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      area = { id: kept?.id ?? `area-${slug}-${String(areas.length + 1)}`, label: kept?.label ?? label.slice(0, 200), x: 0, y: 0, members: [] };
      areas.push(area);
    }
    area.members!.push(agent.agentId);
  }
  const cards = cardRects(agents, positions);
  const placedAreas = areas.map((a) => storedArea(a, cards));

  const same =
    placedAreas.length === canvas.areas.length &&
    placedAreas.every((a, i) => JSON.stringify(a) === JSON.stringify(canvas.areas[i])) &&
    agents.every((a) => canvas.positions[a.agentId]?.x === positions[a.agentId].x && canvas.positions[a.agentId]?.y === positions[a.agentId].y);
  if (same) return canvas;
  // Positions of agents no longer in the room stay (a removal can be undone).
  return { ...canvas, positions: { ...canvas.positions, ...positions }, areas: placedAreas };
}

/** Whether `home` — an area — would still be clear of every other area and of
 * every card outside it once it grew to take in a card at `candidate`. */
function areaStaysClear(home: { members: string[] }, candidate: Rect, cards: ReadonlyMap<string, Rect>, areas: readonly (RoomCanvasArea & { members: string[] })[]): boolean {
  const members = home.members.flatMap((id) => {
    const rect = cards.get(id);
    return rect ? [rect] : [];
  });
  const box = boundsOf([...members, candidate]);
  const frame = { x: box.x - AREA_PAD, y: box.y - AREA_BAR, w: box.w + AREA_PAD * 2, h: box.h + AREA_PAD + AREA_BAR };
  const homeIds = new Set(home.members);
  const strangers = [...cards.entries()].filter(([id]) => !homeIds.has(id)).map(([, rect]) => rect);
  if (strangers.some((r) => overlaps(frame, r, 0))) return false;
  // Areas keep their distance from each other: a label bar is wider than a
  // small frame, and two bars side by side would run into one another.
  for (const other of areas) {
    if (other.members === home.members) continue;
    const f = areaRect(other, cards);
    if (overlaps(frame, { x: f.x, y: f.y - AREA_BAR, w: f.w, h: f.h + AREA_BAR }, AREA_GAP)) return false;
  }
  return true;
}

/** Most card positions the relay accepts in one canvas is 500; past this many
 * the ones of agents that are no longer in the room are let go. (Until then
 * they are kept: an agent removed with an undo window gets its place back.) */
export const POSITIONS_SOFT_LIMIT = 400;

export function prunePositions(positions: RoomCanvas["positions"], present: ReadonlySet<string>): RoomCanvas["positions"] {
  if (Object.keys(positions).length <= POSITIONS_SOFT_LIMIT) return positions;
  return Object.fromEntries(Object.entries(positions).filter(([id]) => present.has(id)));
}

/** A free place to the right of every card, for when the tree has no room. */
function farFromEverything(cards: ReadonlyMap<string, Rect>, y: number): { x: number; y: number } {
  const box = boundsOf([...cards.values()]);
  return { x: snap(box.x + box.w + 48), y };
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

/** How far a card may sit from the rest of its area before it counts as
 * having left it. */
export const AREA_LEAVE_GAP = 280;

export interface DragTrack {
  /** The area the card belongs to now, if any. */
  home?: RoomCanvasArea;
  /** Another area the card is over: dropping there changes its area. */
  target?: RoomCanvasArea;
  /** The card is far enough from its area, or over another one, to leave. */
  leaving: boolean;
}

function inside(r: Rect, x: number, y: number): boolean {
  return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
}

/**
 * What dragging card `id` to where `cards` has it means for the areas: it
 * stretches its own area, and leaves it only once more than a card's width
 * away from the others — or when it is over a different area, where
 * changing area is plainly intended at any distance. Pure.
 */
export function trackDrag(areas: readonly RoomCanvasArea[], cards: ReadonlyMap<string, Rect>, id: string): DragTrack {
  const card = cards.get(id);
  if (!card) return { leaving: false };
  const home = areas.find((a) => a.members?.includes(id));
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  const target = areas.find((a) => a !== home && inside(areaRect(a, cards), cx, cy));
  let leaving = false;
  if (home) {
    const others = new Map(cards);
    others.delete(id);
    const base = areaRect(home, others);
    const gx = Math.max(base.x - (card.x + card.w), card.x - (base.x + base.w), 0);
    const gy = Math.max(base.y - (card.y + card.h), card.y - (base.y + base.h), 0);
    const alone = (home.members ?? []).filter((m) => others.has(m)).length === 0;
    leaving = target !== undefined || (!alone && Math.max(gx, gy) > AREA_LEAVE_GAP);
  }
  return { home, target, leaving };
}

/** The areas after card `id` is dropped where `cards` has it. */
export function membershipAfterDrop(areas: readonly RoomCanvasArea[], cards: ReadonlyMap<string, Rect>, id: string): { areas: RoomCanvasArea[]; entered?: string; left?: string } {
  const { home, target, leaving } = trackDrag(areas, cards, id);
  if (!leaving && !target) return { areas: [...areas] };
  const next = areas.map((a) => {
    if (a === home && leaving) return { ...a, members: (a.members ?? []).filter((m) => m !== id) };
    if (a === target) return { ...a, members: [...(a.members ?? []), id] };
    return a;
  });
  return { areas: next, entered: target?.id, left: leaving ? home?.id : undefined };
}

/** A new area holding `ids` (and out of every other area). */
export function groupInto(areas: readonly RoomCanvasArea[], ids: readonly string[], rect: Rect, newId: string): RoomCanvasArea[] {
  const taken = new Set(ids);
  const rest = areas.map((a) => ({ ...a, members: (a.members ?? []).filter((m) => !taken.has(m)) }));
  return [...rest, { id: newId, label: "", x: rect.x, y: rect.y, width: rect.w, height: rect.h, members: [...ids] }];
}

/** `id` and everything below it in the tree. */
export function subtreeIds(agents: readonly RoomAgent[], id: string): string[] {
  const kids = childrenOf(agents);
  const out: string[] = [];
  const queue = [id];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const kid of kids.get(next) ?? []) queue.push(kid.agentId);
  }
  return out;
}

export { GRID };

/** Roughly how wide an area's label is at 100%: its name, its counts and the
 * remove button. The bar is drawn at a constant size on screen, so this is
 * only used to choose where along the frame it can sit. */
export function labelWidthEstimate(name: string, meta: string): number {
  return Math.max(48, name.length * 9) + (meta === "" ? 0 : meta.length * 6.6 + 8) + 28;
}

/**
 * Where an area's label sits so that no link drawn down into the frame goes
 * through it: `linkXs` are where those links enter (distance from the frame's
 * left edge). The label takes the first gap between links that is wide enough
 * for `width`; when none is, the widest one, and the label is cut short of the
 * next link. All in world units.
 */
export function labelSlot(linkXs: readonly number[], frameWidth: number, width: number): { left: number; room: number } {
  const edge = 8;
  const xs = [...linkXs].sort((a, b) => a - b);
  const bounds = [0, ...xs, frameWidth];
  const slots = bounds.slice(0, -1).map((start, i) => {
    const from = i === 0 ? 0 : start + edge;
    const to = (i === bounds.length - 2 ? frameWidth : bounds[i + 1]) - (i === bounds.length - 2 ? 0 : edge);
    return { left: from, room: Math.max(0, to - from) };
  });
  return slots.find((slot) => slot.room >= width) ?? slots.reduce((best, slot) => (slot.room > best.room ? slot : best));
}
