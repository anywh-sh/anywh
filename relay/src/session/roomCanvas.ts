// The canvas of each room — where its cards sit, its named areas, free text
// placed on it, and the camera — kept by the relay rather than the client so
// every device showing a room shows the same layout. Nothing an agent needs:
// the room's own data (who is in it, who reports to whom, reports) lives on
// each session (`SessionEntry.room`); this sidecar is presentation only.
//
// One JSON file per profile (`<profile>-rooms.json`, next to the sessions
// file), written whole and atomically. A canvas that does not validate is
// dropped on load rather than crashing the relay or reaching a client.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasArea {
  id: string;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Session ids of the agents placed in the area. */
  members?: string[];
}

export interface CanvasText {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface CanvasCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface RoomCanvas {
  /** Card position per agent (session id). */
  positions: Record<string, CanvasPoint>;
  areas: CanvasArea[];
  texts: CanvasText[];
  camera?: CanvasCamera;
  /** The person arranged something by hand: clients stop laying the whole
   * room out again and only place newcomers. */
  manual?: boolean;
}

export const EMPTY_CANVAS: RoomCanvas = { positions: {}, areas: [], texts: [] };

const MAX_POSITIONS = 500;
const MAX_AREAS = 100;
const MAX_TEXTS = 200;
const MAX_LABEL = 200;
const MAX_TEXT = 4000;
const MAX_ID = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

function parsePoint(value: unknown): CanvasPoint | undefined {
  if (!isRecord(value) || !isCoordinate(value.x) || !isCoordinate(value.y)) return undefined;
  return { x: value.x, y: value.y };
}

function parseArea(value: unknown): CanvasArea | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.label !== "string" || value.label.length > MAX_LABEL) return undefined;
  if (!isCoordinate(value.x) || !isCoordinate(value.y)) return undefined;
  if (value.width !== undefined && !(isCoordinate(value.width) && value.width >= 0)) return undefined;
  if (value.height !== undefined && !(isCoordinate(value.height) && value.height >= 0)) return undefined;
  if (value.members !== undefined && !(Array.isArray(value.members) && value.members.length <= MAX_POSITIONS && value.members.every(isId))) return undefined;
  return {
    id: value.id,
    label: value.label,
    x: value.x,
    y: value.y,
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.members !== undefined ? { members: [...value.members] } : {}),
  };
}

function parseText(value: unknown): CanvasText | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.text !== "string" || value.text.length > MAX_TEXT) return undefined;
  if (!isCoordinate(value.x) || !isCoordinate(value.y)) return undefined;
  return { id: value.id, text: value.text, x: value.x, y: value.y };
}

/**
 * The canvas `value` describes, or `undefined` when any part of it is
 * malformed. Strict on purpose: a client sends the whole canvas each time,
 * so rejecting a bad one keeps the last good one instead of storing half of
 * it. Unknown keys are dropped. Pure.
 */
export function parseRoomCanvas(value: unknown): RoomCanvas | undefined {
  if (!isRecord(value)) return undefined;
  const positions: Record<string, CanvasPoint> = {};
  if (value.positions !== undefined) {
    if (!isRecord(value.positions)) return undefined;
    const entries = Object.entries(value.positions);
    if (entries.length > MAX_POSITIONS) return undefined;
    for (const [id, raw] of entries) {
      const point = parsePoint(raw);
      if (!isId(id) || !point) return undefined;
      positions[id] = point;
    }
  }
  const list = <T>(raw: unknown, max: number, parse: (item: unknown) => T | undefined): T[] | undefined => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > max) return undefined;
    const out: T[] = [];
    for (const item of raw) {
      const parsed = parse(item);
      if (!parsed) return undefined;
      out.push(parsed);
    }
    return out;
  };
  const areas = list(value.areas, MAX_AREAS, parseArea);
  const texts = list(value.texts, MAX_TEXTS, parseText);
  if (!areas || !texts) return undefined;
  let camera: CanvasCamera | undefined;
  if (value.camera !== undefined) {
    const raw = value.camera;
    if (!isRecord(raw) || !isCoordinate(raw.x) || !isCoordinate(raw.y) || !(typeof raw.zoom === "number" && Number.isFinite(raw.zoom) && raw.zoom > 0 && raw.zoom <= 100)) {
      return undefined;
    }
    camera = { x: raw.x, y: raw.y, zoom: raw.zoom };
  }
  if (value.manual !== undefined && typeof value.manual !== "boolean") return undefined;
  return { positions, areas, texts, ...(camera ? { camera } : {}), ...(value.manual === true ? { manual: true } : {}) };
}

/** The sidecar file's path for a sessions file: `pessoal.json` →
 * `pessoal-rooms.json`, beside it. */
export function roomCanvasPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-rooms.json` : `${sessionsFile}-rooms.json`;
}

export class RoomCanvasStore {
  private canvases: Record<string, RoomCanvas> = {};

  constructor(private readonly filePath: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      // Missing the first time, or corrupt: start empty, never crash.
      return;
    }
    if (!isRecord(parsed)) return;
    let dropped = false;
    for (const [roomId, raw] of Object.entries(parsed)) {
      const canvas = parseRoomCanvas(raw);
      if (canvas && isId(roomId)) this.canvases[roomId] = canvas;
      else dropped = true;
    }
    if (dropped) this.persist();
  }

  get(roomId: string): RoomCanvas {
    return structuredClone(this.canvases[roomId] ?? EMPTY_CANVAS);
  }

  set(roomId: string, canvas: RoomCanvas): void {
    this.canvases[roomId] = structuredClone(canvas);
    this.persist();
  }

  delete(roomId: string): void {
    if (!(roomId in this.canvases)) return;
    delete this.canvases[roomId];
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.canvases), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
