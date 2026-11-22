// A bot's face: one of ten fixed pixel characters on a 16×16 grid, in one of
// eight tones. The person picks both; nothing is generated or downloaded. The
// outline, light and shade are computed from the tone, so a character looks
// the same in any of them, and the bot's state changes the expression (eyes,
// mouth) without changing who it is.
//
// Pure: no DOM. `Mascot.tsx` draws the layers.

export type MascotCharacter = "bip" | "visor" | "fone" | "topete" | "capacete" | "ciclope" | "tela" | "oculos" | "chip" | "helice";

export type MascotTone = "giz" | "areia" | "salvia" | "oliva" | "rosa" | "nuvem" | "ardosia" | "pedra";

export type MascotState = "idle" | "working" | "needsYou" | "paused" | "setup" | "failed" | "limit";

export interface MascotChoice {
  character: MascotCharacter;
  tone: MascotTone;
}

export const MASCOT_GRID = 16;

type Rect = [x: number, y: number, w: number, h: number];
type MouthKind = "flat" | "smile" | "none" | "sad" | "open";

interface Character {
  /** The tone it comes in: picking the character picks this tone. */
  tone: MascotTone;
  /** 16 rows of 16 cells. `.` empty · `B` body (the tone) · `H` hair or cap
   * (the tone, darkened) · `M` metal · `D` dark (visor, screen, ear cups) ·
   * `L` fixed highlight · `O` forced outline. */
  map: string[];
  eyes: Rect[];
  /** The one light pixel in each eye. */
  shine: [number, number][];
  mouth: [x: number, y: number, w: number, kind: "flat" | "smile" | "none"];
  /** Eyes (and mouth) lit in the tone, lightened: Visor and Tela. */
  glowEyes?: boolean;
  glowMouth?: boolean;
  reflection?: [number, number][];
  mark?: [number, number][];
  /** Ciclope: one big eye with a white. */
  bigEye?: boolean;
  /** Óculos: the frames over the eyes. */
  glasses?: boolean;
}

export const MASCOT_CHARACTERS: Record<MascotCharacter, Character> = {
  bip: {
    tone: "areia",
    map: ["................", ".......LL.......", "......LLLL......", ".......LL.......", ".......MM.......", "...BBBBBBBBBB...", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "...BBBBBBBBBB...", "....BBB..BBB...."],
    eyes: [
      [5, 8, 2, 2],
      [9, 8, 2, 2],
    ],
    shine: [
      [6, 8],
      [10, 8],
    ],
    mouth: [7, 11, 2, "flat"],
  },
  visor: {
    tone: "giz",
    map: ["................", ".......BB.......", "....BBBBBBBB....", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "..MDDDDDDDDDDM..", "..MDDDDDDDDDDM..", "...DDDDDDDDDD...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "....BBBBBBBB....", ".....BB..BB....."],
    eyes: [
      [5, 7, 2, 1],
      [9, 7, 2, 1],
    ],
    shine: [],
    mouth: [7, 11, 2, "flat"],
    glowEyes: true,
    reflection: [[11, 6]],
  },
  fone: {
    tone: "salvia",
    map: ["................", "................", "....MMMMMMMM....", "..MM........MM..", ".M..BBBBBBBB..M.", ".M.BBBBBBBBBB.M.", ".M.BBBBBBBBBB.M.", "DDDBBBBBBBBBBDDD", "DDDBBBBBBBBBBDDD", "DDDBBBBBBBBBBDDD", "DDDBBBBBBBBBBDDD", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "....BBBBBBBB....", ".....BB..BB....."],
    eyes: [
      [5, 7, 2, 2],
      [9, 7, 2, 2],
    ],
    shine: [
      [6, 7],
      [10, 7],
    ],
    mouth: [6, 10, 4, "smile"],
  },
  topete: {
    tone: "pedra",
    map: [".........HHH....", "......HHHHH.....", "....BHHHHHHB....", "...BBBHHHHBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "....OOOOOOOO....", "..BBBBBBBBBBBB..", ".BBBBBBBBBBBBBB.", ".BBBBBDDDDBBBBB.", ".BBBBBDLDDBBBBB.", ".BBBBBBBBBBBBBB."],
    eyes: [
      [5, 5, 2, 2],
      [9, 5, 2, 2],
    ],
    shine: [
      [6, 5],
      [10, 5],
    ],
    mouth: [7, 8, 2, "flat"],
  },
  capacete: {
    tone: "rosa",
    map: ["................", "......HHHH......", "....HHHHHHHH....", "...HHHHLLHHHH...", ".HHHHHHHHHHHHHH.", "...BBBBBBBBBB...", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "...BBBBBBBBBB...", "....BBB..BBB...."],
    eyes: [
      [5, 8, 2, 2],
      [9, 8, 2, 2],
    ],
    shine: [
      [6, 8],
      [10, 8],
    ],
    mouth: [7, 11, 2, "flat"],
  },
  ciclope: {
    tone: "nuvem",
    map: ["................", "................", ".......MM.......", "....BBBBBBBB....", "...BBBBBBBBBB...", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "...BBBBBBBBBB...", "....BBBBBBBB....", ".....BB..BB.....", "................"],
    eyes: [[7, 7, 2, 2]],
    shine: [],
    mouth: [7, 11, 2, "flat"],
    bigEye: true,
  },
  tela: {
    tone: "ardosia",
    map: ["................", "..BBBBBBBBBBBB..", ".BBBBBBBBBBBBBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBDDDDDDDDDDBB.", ".BBBBBBBBBBBBLB.", "..BBBBBBBBBBBB..", "......MMMM......", ".....BBBBBB.....", "....BBBBBBBB....", "................"],
    eyes: [
      [6, 5, 1, 2],
      [9, 5, 1, 2],
    ],
    shine: [],
    mouth: [7, 8, 2, "flat"],
    glowEyes: true,
    glowMouth: true,
    reflection: [
      [11, 4],
      [12, 4],
      [12, 5],
    ],
  },
  oculos: {
    tone: "oliva",
    map: ["................", "................", "....HHHHHHHH....", "...HHHHHHHHHH...", "...HHHBBBBHHH...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "...BBBBBBBBBB...", "....BBBBBBBB....", ".....BB..BB....."],
    eyes: [
      [5, 8, 1, 1],
      [10, 8, 1, 1],
    ],
    shine: [],
    mouth: [6, 11, 4, "smile"],
    glasses: true,
  },
  chip: {
    tone: "salvia",
    map: [".....M....M.....", ".....M....M.....", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "MMBBBBBBBBBBBBMM", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "MMBBBBBBBBBBBBMM", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", ".....M....M.....", ".....M....M....."],
    eyes: [
      [5, 6, 2, 2],
      [9, 6, 2, 2],
    ],
    shine: [
      [6, 6],
      [10, 6],
    ],
    mouth: [7, 10, 2, "flat"],
    mark: [[4, 4]],
  },
  helice: {
    tone: "giz",
    map: ["..MMMMMMMMMMMM..", ".......MM.......", ".......MM.......", ".....HHHHHH.....", "....HHHHHHHH....", "...HHHHHHHHHH...", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB..", "...BBBBBBBBBB...", "....BBB..BBB...."],
    eyes: [
      [5, 8, 2, 2],
      [9, 8, 2, 2],
    ],
    shine: [
      [6, 8],
      [10, 8],
    ],
    mouth: [6, 11, 4, "smile"],
  },
};

/** The order the picker walks the characters in. */
export const MASCOT_ORDER: readonly MascotCharacter[] = ["bip", "visor", "fone", "topete", "capacete", "ciclope", "tela", "oculos", "chip", "helice"];

/** Low-chroma tones, far from the status colors: orange is "needs you" only,
 * red is failed or limited, yellow is near a limit. */
export const MASCOT_TONES: Record<MascotTone, string> = {
  giz: "#e6e1d8",
  areia: "#d9c19a",
  salvia: "#a9bd9f",
  oliva: "#bcb48a",
  rosa: "#d9aab7",
  nuvem: "#b7c4d4",
  ardosia: "#98a3ad",
  pedra: "#aaa49b",
};

export const MASCOT_TONE_ORDER = Object.keys(MASCOT_TONES) as MascotTone[];

/** A paused bot is grey whatever its tone. */
export const MASCOT_PAUSED_TONE = "#77736e";
/** Setting up: only the outline, and the face in a lighter grey. */
const SETUP_OUTLINE = "#6f6b66";
const SETUP_FACE = "#a09c98";

export function isMascotCharacter(value: unknown): value is MascotCharacter {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MASCOT_CHARACTERS, value);
}

export function isMascotTone(value: unknown): value is MascotTone {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MASCOT_TONES, value);
}

/** A character in the tone it comes in. */
export function defaultChoice(character: MascotCharacter): MascotChoice {
  return { character, tone: MASCOT_CHARACTERS[character].tone };
}

/** What a bot's summary carries, read defensively: a relay that sends
 * something else still draws a face. */
export function mascotChoiceOf(mascot: unknown): MascotChoice {
  const value = (typeof mascot === "object" && mascot !== null ? mascot : {}) as { character?: unknown; tone?: unknown };
  const character = isMascotCharacter(value.character) ? value.character : "bip";
  return { character, tone: isMascotTone(value.tone) ? value.tone : MASCOT_CHARACTERS[character].tone };
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** `a` moved toward `b` by `t` (0–1), as `#rrggbb`. */
export function mixColor(a: string, b: string, t: number): string {
  const from = channels(a);
  const to = channels(b);
  return `#${from.map((value, i) => Math.round(value + (to[i] - value) * t).toString(16).padStart(2, "0")).join("")}`;
}

function palette(tone: string, state: MascotState): Record<string, string> {
  const base = state === "paused" ? MASCOT_PAUSED_TONE : tone;
  return {
    O: mixColor(base, "#0d0c0b", 0.68),
    B: base,
    Bl: mixColor(base, "#ffffff", 0.32),
    Bs: mixColor(base, "#000000", 0.2),
    H: mixColor(base, "#000000", 0.38),
    Hl: mixColor(base, "#000000", 0.26),
    Hs: mixColor(base, "#000000", 0.46),
    M: "#a39e98",
    Ml: "#c9c4be",
    Ms: "#7d7873",
    D: "#2b2927",
    L: "#f4f1ec",
    Ll: "#ffffff",
    Ls: "#d8d3cc",
    // The face: the eye whites, shine, ink, glow, reflection and mark.
    fl: "#e6ebee",
    fs: "#f9f7f6",
    fk: "#1d1b19",
    fg: mixColor(base, "#ffffff", 0.62),
    fw: "#f9f7f6",
    fe: "#4d4a46",
    fd: "#2b2927",
  };
}

/** The layers' drawing order, bottom to top. */
const LAYERS = ["O", "B", "Bl", "Bs", "H", "Hl", "Hs", "M", "Ml", "Ms", "D", "L", "Ll", "Ls", "fl", "fs", "fk", "fg", "fw", "fe", "fd"] as const;

export interface MascotLayer {
  layer: string;
  color: string;
  /** Cells of the 16×16 grid, as horizontal runs. */
  rects: Rect[];
}

/** The figure as colored layers of 1-cell-high runs, bottom to top. */
export function mascotLayers(choice: MascotChoice, state: MascotState = "idle"): MascotLayer[] {
  const c = MASCOT_CHARACTERS[choice.character];
  const colors = palette(MASCOT_TONES[choice.tone], state);

  // 1. The outline: every silhouette cell with an empty side (the grid's
  // edge counts as empty), and every forced one.
  const shape = new Map<string, string>();
  c.map.forEach((row, y) => {
    for (let x = 0; x < MASCOT_GRID; x++) if (row[x] !== ".") shape.set(`${String(x)},${String(y)}`, row[x]);
  });
  const filled = (x: number, y: number): boolean => shape.has(`${String(x)},${String(y)}`);
  const outline = new Set<string>();
  for (const [key, kind] of shape) {
    const [x, y] = key.split(",").map(Number);
    const edge = x === 0 || x === MASCOT_GRID - 1 || y === 0 || y === MASCOT_GRID - 1;
    if (kind === "O" || edge || !filled(x, y - 1) || !filled(x - 1, y) || !filled(x, y + 1) || !filled(x + 1, y)) outline.add(key);
  }
  // 2. Light where the outline is above or left, shade where it is below or
  // right.
  const at = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const cellLayer = new Map<string, string>();
  for (const [key, kind] of shape) {
    const [x, y] = key.split(",").map(Number);
    if (outline.has(key)) {
      cellLayer.set(key, "O");
      continue;
    }
    const shaded = "BHML".includes(kind);
    if (shaded && (outline.has(at(x, y - 1)) || outline.has(at(x - 1, y)))) cellLayer.set(key, `${kind}l`);
    else if (shaded && (outline.has(at(x, y + 1)) || outline.has(at(x + 1, y)))) cellLayer.set(key, `${kind}s`);
    else cellLayer.set(key, kind);
  }
  // 3. Horizontal runs per layer.
  const runs: Record<string, Rect[]> = {};
  for (let y = 0; y < MASCOT_GRID; y++) {
    let x = 0;
    while (x < MASCOT_GRID) {
      const layer = cellLayer.get(at(x, y));
      if (!layer) {
        x++;
        continue;
      }
      let end = x;
      while (end + 1 < MASCOT_GRID && cellLayer.get(at(end + 1, y)) === layer) end++;
      (runs[layer] ??= []).push([x, y, end - x + 1, 1]);
      x = end + 1;
    }
  }

  // 4. The face, in the state's expression.
  let eyes = c.eyes.slice();
  let shine = c.shine.slice();
  const mouthY = c.mouth[1];
  let [mouthX, , mouthW, mouthKind] = c.mouth as [number, number, number, MouthKind];
  const lowered = (rect: Rect): Rect => [rect[0], rect[1] + rect[3] - 1, rect[2], 1];
  if (state === "working") {
    // Looking down at the work.
    eyes = eyes.map(lowered);
    shine = [];
    mouthKind = "flat";
  }
  if (state === "paused" || state === "limit") {
    // Eyes shut.
    eyes = eyes.map(lowered);
    shine = [];
    mouthKind = "none";
  }
  if (state === "failed") {
    eyes = eyes.map(([x, y, w]) => [x, y, w, 1] as Rect);
    shine = [];
    mouthKind = "sad";
  }
  if (state === "needsYou") mouthKind = "open";
  let mouth: Rect[] = [];
  if (mouthKind === "flat") mouth = [[mouthX, mouthY, mouthW, 1]];
  if (mouthKind === "smile")
    mouth = [
      [mouthX, mouthY, 1, 1],
      [mouthX + 1, mouthY + 1, mouthW - 2, 1],
      [mouthX + mouthW - 1, mouthY, 1, 1],
    ];
  if (mouthKind === "sad") {
    if (mouthW < 4) {
      mouthX -= 1;
      mouthW = 4;
    }
    mouth = [
      [mouthX, mouthY + 1, 1, 1],
      [mouthX + 1, mouthY, mouthW - 2, 1],
      [mouthX + mouthW - 1, mouthY + 1, 1, 1],
    ];
  }
  if (mouthKind === "open") {
    const center = mouthX + Math.floor(mouthW / 2);
    mouth = [[center - 1, mouthY, 2, 2]];
  }
  const face: Record<string, Rect[]> = { fl: [], fs: [], fk: [], fg: [], fw: [], fe: [], fd: [] };
  if (c.bigEye) {
    if (state === "paused" || state === "limit") {
      face.fk.push([5, 8, 6, 1]);
      eyes = [];
    } else {
      face.fs.push([6, 6, 4, 1], [5, 7, 6, 2], [6, 9, 4, 1]);
      eyes = [state === "working" ? [7, 8, 2, 2] : state === "failed" ? [7, 6, 2, 2] : [7, 7, 2, 2]];
    }
  }
  if (c.glasses) {
    face.fk.push([4, 6, 3, 1], [9, 6, 3, 1], [7, 7, 2, 1]);
    face.fl.push([4, 7, 3, 2], [9, 7, 3, 2]);
  }
  (c.glowEyes ? face.fg : face.fk).push(...eyes);
  face.fw.push(...shine.map(([x, y]) => [x, y, 1, 1] as Rect));
  face.fe.push(...(c.reflection ?? []).map(([x, y]) => [x, y, 1, 1] as Rect));
  face.fd.push(...(c.mark ?? []).map(([x, y]) => [x, y, 1, 1] as Rect));
  (c.glowMouth ? face.fg : face.fk).push(...mouth);

  // 5. Setting up: only the outline, and the eyes and mouth.
  const setup = state === "setup";
  return LAYERS.map((layer) => {
    const isFace = layer.startsWith("f");
    const rects = isFace ? face[layer] : (runs[layer] ?? []);
    const shown = !setup || layer === "O" || layer === "fk" || layer === "fg";
    const color = setup ? (isFace ? SETUP_FACE : SETUP_OUTLINE) : colors[layer];
    return { layer, color, rects: shown ? rects : [] };
  }).filter((each) => each.rects.length > 0);
}

/** The figure as a palette and 256 characters, row by row: `.` empty, and
 * `a`, `b`, … the palette's first, second, … color. What the iOS drawer
 * gets: it paints squares, it never draws a character itself. */
export function mascotPixels(choice: MascotChoice, state: MascotState = "idle"): { pixels: string; palette: string[] } {
  const cells = Array.from({ length: MASCOT_GRID * MASCOT_GRID }, () => ".");
  const colors: string[] = [];
  for (const layer of mascotLayers(choice, state)) {
    let index = colors.indexOf(layer.color);
    if (index === -1) {
      index = colors.length;
      colors.push(layer.color);
    }
    const letter = String.fromCharCode(97 + index);
    for (const [x, y, w, h] of layer.rects) {
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) cells[row * MASCOT_GRID + col] = letter;
    }
  }
  return { pixels: cells.join(""), palette: colors };
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
