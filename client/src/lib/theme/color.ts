/**
 * Small sRGB helpers used to fill in the tokens a custom theme leaves out
 * (themeApply.ts).
 *
 * Why not `color-mix()` in CSS, which the app already uses elsewhere: the
 * derived values also have to reach xterm (TerminalView.tsx), and xterm
 * takes literal colors in a JS object, not CSS. Reading them back with
 * `getComputedStyle` doesn't help either — an unregistered custom property
 * computes to its token stream, so `--bg-sidebar` would come back as the
 * string "color-mix(in srgb, …)" rather than a resolved color. Deriving to
 * literals here keeps one answer for both consumers.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

let probe: HTMLSpanElement | undefined;

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i;

/**
 * Hex and plain `rgb()` — every built-in token, and what most hand-written
 * themes use — resolved without the engine. Not just a shortcut: it is what
 * lets the unit tier (happy-dom, whose `getComputedStyle` computes no
 * `color`) run the real derivation in `themeApply.ts` for a theme written in
 * these forms, instead of silently getting the built-in fallback for every
 * derived token. Anything else still goes through the probe below.
 */
function parseLiteral(value: string): Rgba | undefined {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const n = (i: number): number => Number.parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4]);
    const parts = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
    if (parts.some(Number.isNaN)) return undefined;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] };
  }
  return undefined;
}

/**
 * Resolves any CSS color the theme validator accepts — including `hsl()`
 * and `oklch()`, which aren't worth hand-parsing — by handing it to the
 * engine and reading back the computed `color`, which is always
 * `rgb()`/`rgba()`. The probe stays attached and hidden: a detached element
 * has no computed style in WebKit.
 */
export function parseColor(value: string): Rgba | undefined {
  const literal = parseLiteral(value);
  if (literal) return literal;
  if (typeof document === "undefined") return undefined;
  if (!probe) {
    probe = document.createElement("span");
    probe.style.display = "none";
    document.documentElement.append(probe);
  }
  // A value the engine rejects leaves the previous one in place, so the
  // reset is what turns "invalid" into a detectable empty string.
  probe.style.color = "";
  probe.style.color = value;
  if (probe.style.color === "") return undefined;

  const computed = getComputedStyle(probe).color;
  const match = /^rgba?\(([^)]+)\)$/.exec(computed);
  if (!match) return undefined;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return undefined;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
}

export function toCss({ r, g, b, a }: Rgba): string {
  const round = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
  return a >= 1
    ? `rgb(${String(round(r))} ${String(round(g))} ${String(round(b))})`
    : `rgb(${String(round(r))} ${String(round(g))} ${String(round(b))} / ${a.toFixed(3)})`;
}

/** `ratio` 0 keeps `a`, 1 becomes `b`. Alpha travels with the mix. */
export function mix(a: Rgba, b: Rgba, ratio: number): Rgba {
  const t = Math.min(1, Math.max(0, ratio));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** Toward black by `percent` — "one step down" in the surface stack. */
export function shade(color: Rgba, percent: number): Rgba {
  return mix(color, BLACK, percent / 100);
}

/** Toward white by `percent` — "one step up" in the surface stack. */
export function tint(color: Rgba, percent: number): Rgba {
  return mix(color, WHITE, percent / 100);
}

/**
 * Perceived brightness (ITU-R BT.601), 0–255. Used to pick a direction
 * (lighten vs darken) without trusting the theme's declared `appearance`,
 * which an author can get wrong — a "light" theme with a near-black
 * background would otherwise derive a set of surfaces nobody can read.
 */
export function luminance({ r, g, b }: Rgba): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * WCAG 2.1 relative luminance, 0–1. Deliberately not the same function as
 * `luminance` above and not interchangeable with it: that one is a cheap
 * weighted average of the raw channels, good enough to answer "is this
 * background dark?", while this one linearizes each channel first, which is
 * what makes the ratio below correspond to what a person can actually read.
 * BT.601 would call `#e0642a` and `#eceae4` far apart; the linearized numbers
 * put them at 2.9:1, which is under the readability floor.
 */
function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio between two opaque colors, 1–21. Alpha is ignored:
 * a translucent color has no contrast of its own until it's composited, so
 * callers flatten first. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Which end of a theme's own ramp to print *on* a filled accent. Answering
 * "the foreground, obviously" is what produced a 2.9:1 button label on the
 * built-in dark theme: an accent saturated enough to read as an accent sits
 * between the page and its text, so which end wins is a measurement, not a
 * property of whether the theme is dark or light.
 *
 * Pure, and separate from `themeApply.ts`, because it is the only part of the
 * derivation a test can reach: `parseColor` above needs `getComputedStyle` to
 * resolve a color, and the unit tier's happy-dom returns nothing for it — so
 * every derivation that starts from a parse is, in that tier, silently the
 * built-in fallback instead.
 */
export function readableInkOn(fill: Rgba, background: Rgba, foreground: Rgba): Rgba {
  return contrastRatio(fill, background) >= contrastRatio(fill, foreground) ? background : foreground;
}

/** `top` composited over an opaque `bottom` — what a translucent token
 * actually looks like once it is sitting on a surface. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  return { ...mix(bottom, { ...top, a: 1 }, top.a), a: 1 };
}

/**
 * `ink` as it was derived, or — when that misses `minimum` on any of
 * `surfaces` — the first step from it toward `toward` that doesn't. A derived
 * token is a guess made from someone else's palette, and the guess that
 * reads fine on a dark page can sit at 3:1 on a pale one; this turns the
 * guess into a floor instead of hoping. Stops at `toward` itself if nothing
 * on the way gets there (the theme's own ink is then the best there is).
 * Pure, like `readableInkOn`, so the unit tier can check it.
 */
export function legibleOn(ink: Rgba, surfaces: Rgba[], minimum: number, toward: Rgba): Rgba {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(ink, toward, step / 20);
    if (surfaces.every((surface) => contrastRatio(over(candidate, surface), surface) >= minimum)) return candidate;
  }
  return toward;
}
