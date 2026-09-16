// Theme file format and its validator. Duplicated verbatim in
// client/src/lib/theme.ts — the two sides need the exact same answer about
// whether a theme file is broken, and there's no shared package in this repo
// (same call as planChoiceMarker.ts, which is duplicated for the same
// reason). Keep them in sync; the client copy carries no extra logic.
//
// The client validates so it can show a specific error before any round
// trip; the relay validates again because it writes the file to disk and
// can't trust a body just because some client said it was fine.
//
// The validator reports a CODE, never a sentence: both sides run it, and the
// relay's copy of an error travels back in the HTTP error body to land in the
// same list the client's own errors do. See `ThemeValidationError`.

export const THEME_VERSION = 1;

export type ThemeAppearance = "dark" | "light";

/** Ids that a custom theme can never take: they're the built-in themes
 * (client/src/lib/builtinThemes.ts), which don't live on disk at all, so a
 * custom file under one of these names would be permanently shadowed. */
export const RESERVED_THEME_IDS = ["default", "papel"];

/**
 * Without these six, there's no theme — a file missing `background` or
 * `foreground` isn't a partial theme, it's an unusable one. Everything else
 * is optional and falls back to the built-in of the same `appearance`, so a
 * short theme file is a legitimate way to write one.
 */
export const REQUIRED_COLOR_KEYS = [
  "background",
  "foreground",
  "muted-foreground",
  "primary",
  "destructive",
  "border",
] as const;

/**
 * Every key here maps 1:1 to the CSS custom property of the same name
 * (`background` -> `--background`), which is what makes applying a theme a
 * plain loop over the entries (client/src/lib/themeApply.ts) instead of a
 * translation table. Keep in sync with the `:root` block in
 * client/src/index.css — a token that exists there but not here can't be
 * themed, and one that exists here but not there does nothing.
 */
export const OPTIONAL_COLOR_KEYS = [
  "bg-sidebar",
  "bg-chrome",
  "bg-elevated",
  "surface-hover",
  "card",
  "bubble-user",
  "text-faint",
  "primary-soft",
  "primary-ink",
  // The label on a filled button. Derived from the accent itself
  // (themeApply.ts) rather than defaulting to `foreground`, which is
  // unreadable on any mid-tone accent — declarable here only so a theme whose
  // accent sits near the middle can make the call itself.
  "primary-foreground",
  "destructive-foreground",
  "border-soft",
  "context-ring-warn",
  "diff-add",
  "overlay",
  "glass-tint",
  "media-scrim",
  "media-scrim-foreground",
  "shadow-color",
  "syntax-comment",
  "syntax-keyword",
  "syntax-string",
  "syntax-number",
  "syntax-title",
  "profile-1",
  "profile-2",
  "profile-3",
  "profile-4",
  "profile-5",
  "profile-6",
] as const;

export type RequiredColorKey = (typeof REQUIRED_COLOR_KEYS)[number];
export type OptionalColorKey = (typeof OPTIONAL_COLOR_KEYS)[number];
export type ThemeColorKey = RequiredColorKey | OptionalColorKey;

/**
 * xterm's own option names, not kebab-case CSS names like `colors` above:
 * these never become CSS custom properties (xterm takes literal colors in a
 * JS object, TerminalView.tsx), and anyone writing a terminal palette
 * already knows this vocabulary from every other terminal theme.
 */
export const TERMINAL_COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number];

export interface Theme {
  version: typeof THEME_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: Record<RequiredColorKey, string> & Partial<Record<OptionalColorKey, string>>;
  terminal?: Partial<Record<TerminalColorKey, string>>;
  /** Written by the relay on save, never by the author — last-write-wins
   * marker for the same theme edited from two devices. */
  updatedAt?: string;
}

/**
 * A problem with a theme file, as a code rather than a sentence. Same
 * contract as the relay's other failures (`SetCwdError`, `EditMessageError`):
 * the side that finds the problem names it, the side with a user writes the
 * words. That split matters more here than elsewhere — this validator runs
 * on both sides, and the relay's copy of an error travels back in an HTTP
 * body and lands in the same list in the import dialog, so a sentence
 * written here would arrive in whatever language the relay was built in,
 * next to sentences in the language the user picked.
 *
 * Each variant carries what the sentence needs to interpolate, so the copy
 * never has to parse a string back apart.
 */
export type ThemeValidationError = {
  /** Dotted path into the file (`colors.background`), so the UI can point
   * at the offending line instead of saying "invalid theme". */
  path: string;
} & (
  | { code: "not_an_object" }
  | { code: "expected_color_map" }
  | { code: "unknown_token" }
  | { code: "invalid_color" }
  | { code: "wrong_version"; expected: number }
  | { code: "invalid_id"; maxLength: number }
  | { code: "reserved_id"; id: string }
  | { code: "invalid_name"; maxLength: number }
  | { code: "invalid_appearance" }
  | { code: "missing_colors"; missing: string[] }
);

export type ThemeValidationCode = ThemeValidationError["code"];

export type ThemeValidation =
  | { ok: true; theme: Theme }
  | { ok: false; errors: ThemeValidationError[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ID_LENGTH = 32;
const MAX_NAME_LENGTH = 48;

/**
 * A color value ends up in a CSS custom property, so "any string" is not a
 * safe default. The CSSOM already drops values it can't parse, but plenty
 * of *parseable* values are still wrong to accept here: `url(https://…)` in
 * a background token turns opening a theme someone sent you into an
 * outbound request that leaks your IP, and `var(…)` lets a theme reference
 * (or cycle through) the app's own tokens. Whitelisting the formats is the
 * only version of this check that's actually a check.
 *
 * No nested parens in the function form on purpose — that's what keeps
 * `rgb(var(--x))` and friends out.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%,/\s+-]*\)$/i;
const MAX_COLOR_LENGTH = 64;

export function isValidColorValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) return false;
  const trimmed = value.trim();
  if (trimmed === "transparent") return true;
  return HEX_COLOR.test(trimmed) || FUNCTIONAL_COLOR.test(trimmed);
}

export function isValidThemeId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id);
}

function validateColorMap(
  raw: unknown,
  path: string,
  allowedKeys: readonly string[],
  errors: ThemeValidationError[],
): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ path, code: "expected_color_map" });
    return result;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowedKeys.includes(key)) {
      // Rejected, not ignored: a typo'd token that silently does nothing is
      // exactly the "my theme file is broken and I can't tell why" case
      // this validator exists to catch.
      errors.push({ path: `${path}.${key}`, code: "unknown_token" });
      continue;
    }
    if (typeof value !== "string" || !isValidColorValue(value)) {
      errors.push({ path: `${path}.${key}`, code: "invalid_color" });
      continue;
    }
    result[key] = value.trim();
  }
  return result;
}

/**
 * Parses and validates a theme file. Collects every problem instead of
 * failing on the first one — someone hand-writing a theme should see the
 * whole list in one pass, not fix six typos in six round trips.
 */
export function parseTheme(input: unknown): ThemeValidation {
  const errors: ThemeValidationError[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "", code: "not_an_object" }] };
  }
  const raw = input as Record<string, unknown>;

  if (raw.version !== THEME_VERSION) {
    errors.push({ path: "version", code: "wrong_version", expected: THEME_VERSION });
  }

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isValidThemeId(id)) {
    errors.push({ path: "id", code: "invalid_id", maxLength: MAX_ID_LENGTH });
  } else if (RESERVED_THEME_IDS.includes(id)) {
    errors.push({ path: "id", code: "reserved_id", id });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    errors.push({ path: "name", code: "invalid_name", maxLength: MAX_NAME_LENGTH });
  }

  const appearance = raw.appearance;
  if (appearance !== "dark" && appearance !== "light") {
    errors.push({ path: "appearance", code: "invalid_appearance" });
  }

  const allColorKeys: readonly string[] = [...REQUIRED_COLOR_KEYS, ...OPTIONAL_COLOR_KEYS];
  const colors = validateColorMap(raw.colors, "colors", allColorKeys, errors);
  // Only keys that aren't in the file at all. A required key that IS there
  // but holds an invalid color already produced its own, more specific
  // error — listing it again as "missing" reads like two separate problems.
  const declaredKeys = typeof raw.colors === "object" && raw.colors !== null ? Object.keys(raw.colors) : [];
  const missing = REQUIRED_COLOR_KEYS.filter((key) => !declaredKeys.includes(key));
  if (missing.length > 0) {
    errors.push({ path: "colors", code: "missing_colors", missing: [...missing] });
  }

  let terminal: Record<string, string> | undefined;
  if (raw.terminal !== undefined) {
    terminal = validateColorMap(raw.terminal, "terminal", TERMINAL_COLOR_KEYS, errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    theme: {
      version: THEME_VERSION,
      id,
      name,
      appearance: appearance as ThemeAppearance,
      colors: colors as Theme["colors"],
      ...(terminal && Object.keys(terminal).length > 0 ? { terminal } : {}),
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    },
  };
}

/** One line per problem, in English, for a `console.error` on the relay and
 * for the `Error.message` of a failed save. Not what the import dialog
 * renders — that one resolves each code through the dictionary, so the user
 * reads the problem in their own language. */
export function formatThemeErrors(errors: ThemeValidationError[]): string {
  const describe = (error: ThemeValidationError): string => {
    switch (error.code) {
      case "not_an_object":
        return "expected a JSON object";
      case "expected_color_map":
        return "expected an object of colors";
      case "unknown_token":
        return "unknown token";
      case "invalid_color":
        return "invalid color — use hex (#rrggbb), rgb()/hsl()/oklch() or transparent";
      case "wrong_version":
        return `expected version ${String(error.expected)}`;
      case "invalid_id":
        return `invalid id — lowercase, digits and hyphen, up to ${String(error.maxLength)} characters`;
      case "reserved_id":
        return `"${error.id}" is a reserved built-in theme id`;
      case "invalid_name":
        return `name is required, up to ${String(error.maxLength)} characters`;
      case "invalid_appearance":
        return 'expected "dark" or "light"';
      case "missing_colors":
        return `missing: ${error.missing.join(", ")}`;
    }
  };
  return errors.map((error) => (error.path ? `${error.path}: ${describe(error)}` : describe(error))).join("\n");
}
