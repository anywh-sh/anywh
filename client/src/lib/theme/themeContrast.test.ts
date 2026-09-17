import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES } from "@/lib/theme/builtinThemes";
import { readableInkOn } from "@/lib/theme/color";
import type { Theme, ThemeColorKey } from "@/lib/theme/theme";

/**
 * Contrast of the two built-in themes, measured instead of eyeballed.
 *
 * The light theme is what makes this worth a test: the dark one was looked at
 * on every screen while it was being built, and a light theme is where a
 * color chosen against a near-black surface quietly stops being readable. A
 * ratio is also the one property of a palette that a human reviewer cannot
 * estimate — 3.2 and 4.6 look equally fine side by side on a good monitor,
 * and only one of them is legible on a laptop screen at an airport.
 *
 * The bar is WCAG 2.1's 4.5:1 for text (1.4.3), with no large-text exemption
 * claimed anywhere: most of the faint text in this app is 10–11px, which is
 * the opposite of large. The one lower bar is syntax highlighting, argued for
 * where it is applied.
 */
type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?\s*\)/i.exec(value);
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
  }
  // The validator accepts oklch() too. No built-in uses one today, and a
  // silent skip here would turn this whole file into a no-op the first time
  // one did — so refuse loudly instead.
  throw new Error(`themeContrast: cannot measure ${value}`);
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function flatten(color: Rgba, behind: Rgba): Rgba {
  return [0, 1, 2].map((i) => color[i] * color[3] + behind[i] * (1 - color[3])).concat(1) as Rgba;
}

/** Ratio of `ink` over `surface`, both resolved against the theme's page
 * color first — a translucent token (`--primary-soft`) has no contrast of its
 * own until it's sitting on something. */
function contrast(theme: Theme, ink: ThemeColorKey, surface: ThemeColorKey): number {
  const page = parse(theme.colors.background ?? "#000000");
  const resolvedSurface = flatten(parse(theme.colors[surface] ?? ""), page);
  const resolvedInk = flatten(parse(theme.colors[ink] ?? ""), resolvedSurface);
  const a = luminance(resolvedInk);
  const b = luminance(resolvedSurface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every surface a piece of text can land on, darkest to lightest in the dark
 * theme. `surface-hover` is in here because it's the one that moves under the
 * pointer: text that passes on the row and fails on the hovered row is a
 * regression nobody sees in a screenshot. */
const SURFACES: ThemeColorKey[] = [
  "background",
  "bg-sidebar",
  "bg-chrome",
  "bg-elevated",
  "surface-hover",
  "card",
  "bubble-user",
];

/** The three-step ink ramp. `text-faint` is the interesting one: it carries
 * the status bar, the session timestamps, the breadcrumb and the inactive tab
 * labels — all of it at 10–11px. */
const INKS: ThemeColorKey[] = ["foreground", "muted-foreground", "text-faint"];

function report(pairs: { name: string; ratio: number }[], minimum: number): string[] {
  return pairs.filter((pair) => pair.ratio < minimum).map((pair) => `${pair.name} = ${pair.ratio.toFixed(2)}`);
}

describe.each(BUILTIN_THEMES.map((theme) => [theme.name, theme] as const))("%s", (_name, theme) => {
  it("keeps every ink readable on every surface", () => {
    const pairs = INKS.flatMap((ink) =>
      SURFACES.map((surface) => ({ name: `${ink} on ${surface}`, ratio: contrast(theme, ink, surface) })),
    );
    expect(report(pairs, 4.5)).toEqual([]);
  });

  it("keeps the accents readable where they are used as text", () => {
    // Each of these renders as a word or a number somewhere: `destructive` is
    // the delete verbs, `diff-add` is the `+12` on a tool call card and the
    // added lines inside it, and `primary-ink` is the text on the tinted
    // `primary-soft` surface. Text tinted `primary` outright is rare by
    // design — tinted surfaces carry `primary-ink` instead — so it is checked
    // against the page and not against every panel: on the light theme's
    // sidebar tint the brand orange measures 4.39, and the brand's hex is not
    // this test's to move. Today nothing but an icon lands there.
    const pairs = [
      { name: "primary on background", ratio: contrast(theme, "primary", "background") },
      { name: "destructive on background", ratio: contrast(theme, "destructive", "background") },
      { name: "destructive on bg-elevated", ratio: contrast(theme, "destructive", "bg-elevated") },
      { name: "diff-add on background", ratio: contrast(theme, "diff-add", "background") },
      { name: "diff-add on card", ratio: contrast(theme, "diff-add", "card") },
      { name: "primary-ink on primary-soft", ratio: contrast(theme, "primary-ink", "primary-soft") },
    ];
    expect(report(pairs, 4.5)).toEqual([]);
  });

  it("keeps the label on a filled button readable", () => {
    const pairs = [
      { name: "primary-foreground on primary", ratio: contrast(theme, "primary-foreground", "primary") },
      { name: "destructive-foreground on destructive", ratio: contrast(theme, "destructive-foreground", "destructive") },
    ];
    expect(report(pairs, 4.5)).toEqual([]);
  });

  it("keeps syntax highlighting legible in a code block", () => {
    // 3.0, not 4.5, and deliberately so: dimming comments below the code they
    // annotate is what every syntax theme does, and the highlight is never the
    // only way to read a token — the text is still there at full `foreground`
    // weight if the color says nothing. Lowering the bar for *prose* would not
    // be defensible; lowering it for a highlight is.
    const pairs = (["syntax-comment", "syntax-keyword", "syntax-string", "syntax-number", "syntax-title"] as const).map(
      (key) => ({ name: `${key} on card`, ratio: contrast(theme, key, "card") }),
    );
    expect(report(pairs, 3.0)).toEqual([]);
  });
});

/**
 * The built-ins declare their own on-fill ink, so the choice above only ever
 * runs for a theme somebody wrote by hand — which is exactly the theme nobody
 * measured. A six-color theme file is legal (REQUIRED_COLOR_KEYS), and before
 * this existed every one of them got `foreground` on its accent, whatever
 * that accent happened to be.
 *
 * `readableInkOn` is checked here rather than through `resolveTheme` because
 * the full derivation can't run in this tier at all: it starts from
 * `parseColor`, which needs `getComputedStyle`, and happy-dom returns nothing
 * for that — every derived token silently becomes the built-in fallback.
 */
describe("the ink chosen for a hand-written theme's filled buttons", () => {
  const rgb = (value: string) => {
    const n = Number.parseInt(value.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  };
  const ratio = (a: string, b: string): number => {
    const x = luminance(parse(a));
    const y = luminance(parse(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const hex = ({ r, g, b }: { r: number; g: number; b: number }): string =>
    `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

  it.each([
    ["a mid-tone accent on a dark page", "#e0642a", "#111111", "#eeeeee"],
    ["a mid-tone accent on a light page", "#c2440f", "#fafafa", "#111111"],
    ["an accent brighter than the page's text", "#ffd400", "#111111", "#eeeeee"],
    ["an accent darker than the page's background", "#241a5e", "#fafafa", "#111111"],
  ])("stays readable with %s", (_case, primary, background, foreground) => {
    const ink = hex(readableInkOn(rgb(primary), rgb(background), rgb(foreground)));
    expect(ratio(ink, primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("takes the foreground when that is the readable end", () => {
    // The branch the built-ins never exercise — both of them land on their
    // background. A pale accent inverts it.
    const ink = readableInkOn(rgb("#fff3c4"), rgb("#fafafa"), rgb("#111111"));
    expect(hex(ink)).toBe("#111111");
  });
});
