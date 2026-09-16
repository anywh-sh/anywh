import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV_DIR } from "./profileRegistry.js";
import { formatThemeErrors, isValidThemeId, parseTheme, type Theme, type ThemeValidationError } from "./theme.js";

// Host-side registry of custom themes — one file per theme, next to
// `profiles.json`. Machine-wide, not per-profile, for the two reasons the
// feature asks for: a theme added once has to be selectable from every
// profile, and every device syncing against this host sees the same list.
//
// Derived from ENV_DIR (`~/.config/anywh/env`) rather than from `homedir()`
// directly, so overriding `ANYWH_ENV_DIR` in a test relocates both
// registries together.
export const THEMES_DIR = process.env.ANYWH_THEMES_DIR ?? join(dirname(ENV_DIR), "themes");

/** Ceiling on what a single theme file may contain. Nothing legitimate gets
 * close (the built-in with every token spelled out is ~2 KB) — this is here
 * so a stray large file in the directory can't be read into memory on every
 * list. Mirrors the request body cap in server.ts. */
const MAX_THEME_BYTES = 64 * 1024;

/** Carries the per-field errors through to the route, which sends them back
 * so the import UI can point at the offending line. */
export class ThemeValidationFailure extends Error {
  constructor(
    message: string,
    readonly errors: ThemeValidationError[],
  ) {
    super(message);
    this.name = "ThemeValidationFailure";
  }
}

function themePath(id: string, themesDir: string): string {
  return join(themesDir, `${id}.json`);
}

/**
 * `GET /control/themes`. A file that no longer validates — hand-edited on
 * disk, or written by a newer version of the app — is skipped with a log
 * instead of failing the whole list: one broken theme shouldn't cost the
 * user access to the others, same posture `readProfilesJson` takes with a
 * corrupt `profiles.json`.
 */
export function listThemes(themesDir: string = THEMES_DIR): Theme[] {
  if (!existsSync(themesDir)) return [];

  const themes: Theme[] = [];
  for (const name of readdirSync(themesDir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidThemeId(id)) continue;

    const path = join(themesDir, name);
    try {
      const content = readFileSync(path, "utf8");
      if (content.length > MAX_THEME_BYTES) {
        console.error("[relay] skipping oversized theme file:", path);
        continue;
      }
      const result = parseTheme(JSON.parse(content));
      if (!result.ok) {
        console.error(`[relay] skipping invalid theme ${path}:\n${formatThemeErrors(result.errors)}`);
        continue;
      }
      // The filename is what the client selects by, so a file whose inner
      // `id` drifted from it (renamed by hand) would be unselectable.
      if (result.theme.id !== id) {
        console.error(`[relay] skipping theme ${path}: id "${result.theme.id}" does not match filename`);
        continue;
      }
      themes.push(result.theme);
    } catch (error) {
      console.error(`[relay] failed to read theme ${path}:`, error);
    }
  }

  return themes.sort((a, b) => a.name.localeCompare(b.name));
}

export function readTheme(id: string, themesDir: string = THEMES_DIR): Theme | undefined {
  if (!isValidThemeId(id)) return undefined;
  return listThemes(themesDir).find((theme) => theme.id === id);
}

/**
 * `PUT /control/themes/:id`. Revalidates the payload here rather than
 * trusting the client's own check — this is the side that writes to disk.
 * Creating and overwriting are the same operation on purpose: a theme
 * edited on one device and pushed again is the normal way to update one,
 * and `updatedAt` (stamped here, never by the author) is what makes the
 * last write win when two devices race.
 */
export function saveTheme(input: unknown, themesDir: string = THEMES_DIR): Theme {
  const result = parseTheme(input);
  if (!result.ok) {
    throw new ThemeValidationFailure(formatThemeErrors(result.errors), result.errors);
  }

  const theme: Theme = { ...result.theme, updatedAt: new Date().toISOString() };
  mkdirSync(themesDir, { recursive: true });
  writeFileSync(themePath(theme.id, themesDir), `${JSON.stringify(theme, null, 2)}\n`);
  return theme;
}

/** `DELETE /control/themes/:id`. Deliberately does not touch the profiles
 * still pointing at this theme: keeping the dangling `themeId` means
 * re-adding the theme restores the selection, and a profile whose theme is
 * missing already falls back to the built-in on the client. */
export function deleteTheme(id: string, themesDir: string = THEMES_DIR): boolean {
  if (!isValidThemeId(id)) return false;
  const path = themePath(id, themesDir);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
