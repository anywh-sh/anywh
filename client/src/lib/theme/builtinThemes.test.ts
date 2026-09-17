import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES, DEFAULT_THEME, PAPER_THEME } from "@/lib/theme/builtinThemes";
import { OPTIONAL_COLOR_KEYS, REQUIRED_COLOR_KEYS, RESERVED_THEME_IDS, type ThemeColorKey } from "@/lib/theme/theme";

/**
 * `index.css`'s `:root` block paints the very first frame — before any JS
 * runs, so before `themeApply.ts` can write a single custom property — and is
 * also the fallback for every token a custom theme leaves undeclared.
 * `DEFAULT_THEME` is the same palette expressed as data. Nothing enforced
 * that the two agreed: the rule lived in a comment in both files, and drifting
 * them apart produces a bug that only shows for the fraction of a second
 * before the first paint, or only on a token a custom theme happens to omit.
 */
// Resolved from the runner's cwd (always `client/`, where vitest.config.ts
// lives) — `import.meta.url` isn't a file:// URL under Vite's transform.
const CSS = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function rootTokens(): Map<string, string> {
  const start = CSS.indexOf(":root {");
  expect(start, "index.css must declare a `:root` block").toBeGreaterThan(-1);
  const end = CSS.indexOf("\n}", start);
  const block = CSS.slice(start, end);

  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

const ALL_COLOR_KEYS: readonly ThemeColorKey[] = [...REQUIRED_COLOR_KEYS, ...OPTIONAL_COLOR_KEYS];

describe("built-in themes", () => {
  it("declares every themeable token in the default theme", () => {
    // A missing key here would make `themeApply.ts`'s `fallback()` return "",
    // i.e. write an empty custom property, for any custom theme that omits it.
    const declared = Object.keys(DEFAULT_THEME.colors);
    expect(new Set(declared)).toEqual(new Set(ALL_COLOR_KEYS));
  });

  it("keeps index.css and the default theme in sync", () => {
    const tokens = rootTokens();
    const drift: string[] = [];
    for (const key of ALL_COLOR_KEYS) {
      const css = tokens.get(key);
      const theme = DEFAULT_THEME.colors[key];
      if (css !== theme) drift.push(`--${key}: ${css ?? "(missing in index.css)"} vs ${theme}`);
    }
    expect(drift).toEqual([]);
  });

  it("declares every themeable token in the light built-in too", () => {
    // A built-in is never resolved against another built-in: an omission here
    // silently inherits the *dark* value (`fallback()` reads DEFAULT_THEME),
    // which on a light theme is not a subtle difference.
    expect(new Set(Object.keys(PAPER_THEME.colors))).toEqual(new Set(ALL_COLOR_KEYS));
  });

  it("reserves the id of every built-in", () => {
    // A custom theme allowed to take a built-in's id would be permanently
    // shadowed — built-ins don't live on disk, so it could never win.
    for (const theme of BUILTIN_THEMES) {
      expect(RESERVED_THEME_IDS).toContain(theme.id);
    }
  });

  it("ships one theme per appearance", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.appearance).sort()).toEqual(["dark", "light"]);
  });
});
