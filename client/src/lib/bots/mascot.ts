// A bot's face: a 12×12 pixel figure generated from a seed (its name, unless
// the person drew another), so the same name always gives the same figure
// and no image is ever downloaded or stored. Parts and tones are picked by a
// hash of the seed; the bot's state changes the face (eyes, mouth) without
// changing who it is.
//
// Pure: no DOM. `Mascot.tsx` draws the cells.

export type MascotState = "idle" | "working" | "needsYou" | "paused" | "setup" | "failed";

export const MASCOT_GRID = 12;

/** Body tones, low in chroma and far from the status colors (orange, red,
 * yellow, cyan) so a state never reads as a face. */
export const MASCOT_TONES = ["#e6e1d8", "#d6bd95", "#a9bd9f", "#d6a9b6", "#aaa49b", "#9ea9b3"] as const;
export const MASCOT_FACE = "#11100e";
export const MASCOT_PAUSED_TONE = "#6f6b64";

export const MASCOT_BODIES = ["block", "tall", "wide", "shoulders"] as const;
export const MASCOT_EYES = ["dots", "wide", "visor", "cyclops"] as const;
export const MASCOT_MOUTHS = ["flat", "smile", "none"] as const;
export const MASCOT_ACCESSORIES = ["antenna", "ears", "spikes", "tuft", "none"] as const;

export interface MascotParts {
  body: (typeof MASCOT_BODIES)[number];
  eyes: (typeof MASCOT_EYES)[number];
  mouth: (typeof MASCOT_MOUTHS)[number];
  accessory: (typeof MASCOT_ACCESSORIES)[number];
  tone: number;
}

/** A filled cell: column, row, and whether it is the face (dark) or body. */
export interface MascotCell {
  x: number;
  y: number;
  face: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BODY_RECTS: Record<MascotParts["body"], Rect[]> = {
  block: [{ x: 1, y: 3, w: 10, h: 9 }],
  tall: [{ x: 2, y: 2, w: 8, h: 10 }],
  wide: [{ x: 0, y: 4, w: 12, h: 8 }],
  shoulders: [
    { x: 2, y: 2, w: 8, h: 7 },
    { x: 0, y: 9, w: 12, h: 3 },
  ],
};

/** FNV-1a: stable across platforms and runs, which is all it needs to be. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mascotParts(seed: string): MascotParts {
  const key = seed.trim().toLowerCase() || "bot";
  // One hash per part, so changing how one part is picked never reshuffles
  // the others.
  const pick = (part: string, n: number): number => hash(`${key}:${part}`) % n;
  return {
    body: MASCOT_BODIES[pick("body", MASCOT_BODIES.length)],
    eyes: MASCOT_EYES[pick("eyes", MASCOT_EYES.length)],
    mouth: MASCOT_MOUTHS[pick("mouth", MASCOT_MOUTHS.length)],
    accessory: MASCOT_ACCESSORIES[pick("accessory", MASCOT_ACCESSORIES.length)],
    tone: pick("tone", MASCOT_TONES.length),
  };
}

/** A different seed for "draw another": the name plus a counter. */
export function rerollSeed(name: string, attempt: number): string {
  return attempt <= 0 ? name : `${name}#${String(attempt)}`;
}

export function mascotTone(parts: MascotParts, state: MascotState): string {
  return state === "paused" ? MASCOT_PAUSED_TONE : MASCOT_TONES[parts.tone % MASCOT_TONES.length];
}

/** The figure's cells for `parts` in `state`, face cells drawn over body
 * cells (each position appears once). */
export function mascotCells(parts: MascotParts, state: MascotState): MascotCell[] {
  const grid: (0 | 1 | 2)[][] = Array.from({ length: MASCOT_GRID }, () => Array<0 | 1 | 2>(MASCOT_GRID).fill(0));
  const fill = (rect: Rect, value: 1 | 2): void => {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (y >= 0 && y < MASCOT_GRID && x >= 0 && x < MASCOT_GRID) grid[y][x] = value;
      }
    }
  };
  const rects = BODY_RECTS[parts.body];
  for (const rect of rects) fill(rect, 1);
  const head = rects[0];

  const accessory: Rect[] = {
    antenna: [
      { x: 5, y: head.y - 1, w: 2, h: 1 },
      { x: 4, y: head.y - 2, w: 4, h: 1 },
    ],
    ears: [
      { x: head.x, y: head.y - 1, w: 2, h: 1 },
      { x: head.x + head.w - 2, y: head.y - 1, w: 2, h: 1 },
    ],
    spikes: [
      { x: 3, y: head.y - 1, w: 1, h: 1 },
      { x: 5, y: head.y - 1, w: 2, h: 1 },
      { x: 8, y: head.y - 1, w: 1, h: 1 },
    ],
    tuft: [
      { x: 5, y: head.y - 1, w: 3, h: 1 },
      { x: 6, y: head.y - 2, w: 1, h: 1 },
    ],
    none: [],
  }[parts.accessory];
  for (const rect of accessory) fill(rect, 1);

  if (state === "setup") {
    // Only the outline: the bot has not said who it is yet.
    const body = grid.map((row) => row.map((cell) => cell !== 0));
    const at = (x: number, y: number): boolean => y >= 0 && y < MASCOT_GRID && x >= 0 && x < MASCOT_GRID && body[y][x];
    const cells: MascotCell[] = [];
    for (let y = 0; y < MASCOT_GRID; y++) {
      for (let x = 0; x < MASCOT_GRID; x++) {
        if (body[y][x] && !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1))) cells.push({ x, y, face: false });
      }
    }
    return cells;
  }

  const eyeY = head.y + 2;
  const eyeRects: Rect[] = {
    dots: [
      { x: 3, y: eyeY, w: 2, h: 2 },
      { x: 7, y: eyeY, w: 2, h: 2 },
    ],
    wide: [
      { x: 2, y: eyeY, w: 3, h: 2 },
      { x: 7, y: eyeY, w: 3, h: 2 },
    ],
    visor: [{ x: 2, y: eyeY, w: 8, h: 2 }],
    cyclops: [{ x: 5, y: eyeY, w: 2, h: 2 }],
  }[parts.eyes];
  // Working looks down (the eyes' lower half); paused and failed have them
  // shut (one line low).
  const shut = state === "paused";
  const lowered = state === "working" || shut;
  for (const rect of eyeRects) fill(lowered ? { ...rect, y: rect.y + 1, h: 1 } : rect, 2);
  if (parts.eyes === "visor" && !lowered) grid[eyeY][8] = 1;

  const mouthY = eyeY + 4;
  if (state === "needsYou") {
    fill({ x: 5, y: mouthY, w: 2, h: 2 }, 2);
  } else if (state === "failed") {
    fill({ x: 5, y: mouthY, w: 2, h: 1 }, 2);
    fill({ x: 4, y: mouthY + 1, w: 1, h: 1 }, 2);
    fill({ x: 7, y: mouthY + 1, w: 1, h: 1 }, 2);
  } else if (parts.mouth === "flat") {
    fill({ x: 5, y: mouthY, w: 2, h: 1 }, 2);
  } else if (parts.mouth === "smile") {
    fill({ x: 4, y: mouthY, w: 1, h: 1 }, 2);
    fill({ x: 7, y: mouthY, w: 1, h: 1 }, 2);
    fill({ x: 5, y: mouthY + 1, w: 2, h: 1 }, 2);
  }

  const cells: MascotCell[] = [];
  for (let y = 0; y < MASCOT_GRID; y++) {
    for (let x = 0; x < MASCOT_GRID; x++) {
      if (grid[y][x] !== 0) cells.push({ x, y, face: grid[y][x] === 2 });
    }
  }
  return cells;
}

/** The figure as 144 characters, row by row: `.` empty, `#` body, `o` face.
 * What the iOS drawer gets: it draws squares, it never generates. */
export function mascotBitmap(parts: MascotParts, state: MascotState): string {
  const rows = Array.from({ length: MASCOT_GRID }, () => Array<string>(MASCOT_GRID).fill("."));
  for (const cell of mascotCells(parts, state)) rows[cell.y][cell.x] = cell.face ? "o" : "#";
  return rows.map((row) => row.join("")).join("");
}

/** What a bot's summary says its face should be. */
export function mascotStateOf(bot: { paused: boolean; firstRun: boolean; needsYou: number; working: number; busy: boolean; lastRunFailed: boolean }): MascotState {
  if (bot.paused) return "paused";
  if (bot.needsYou > 0) return "needsYou";
  if (bot.firstRun) return "setup";
  if (bot.working > 0 || bot.busy) return "working";
  if (bot.lastRunFailed) return "failed";
  return "idle";
}
