import type { Theme } from "@/lib/theme/theme";

/**
 * Themes that ship with the app. They live here, not in the host's theme
 * registry, because they have to exist with the relay unreachable, with a
 * relay too old to know about themes, and on the very first launch before
 * any sync has happened.
 *
 * `default` mirrors the `:root` block in index.css — that block is what
 * paints the first frame (before any JS runs) and the fallback for every
 * token a custom theme leaves out, so the two have to agree. When a token
 * changes, change it in both.
 */
export const DEFAULT_THEME: Theme = {
  version: 1,
  id: "default",
  name: "Noite",
  appearance: "dark",
  colors: {
    background: "#161513",
    "bg-sidebar": "#11100e",
    "bg-chrome": "#11100e",
    "bg-elevated": "#1c1b19",
    "surface-hover": "#22211f",
    card: "#1c1b19",
    "bubble-user": "#242321",

    foreground: "#edebe8",
    "muted-foreground": "#c3c0bd",
    "text-faint": "#a09c98",

    primary: "#e5642a",
    "primary-foreground": "#11100e",
    "primary-soft": "rgb(229 100 42 / 0.14)",
    "primary-ink": "#f89c67",
    destructive: "#f27b69",
    "destructive-foreground": "#11100e",
    "context-ring-warn": "#e9b860",
    "diff-add": "#85cf95",

    border: "#3a3937",
    "border-soft": "#2a2927",

    overlay: "rgb(0 0 0 / 0.5)",
    "glass-tint": "#edebe8",
    "media-scrim": "rgb(0 0 0 / 0.6)",
    "media-scrim-foreground": "#ffffff",
    "shadow-color": "rgb(0 0 0 / 0.75)",

    "syntax-comment": "#71706e",
    "syntax-keyword": "#c1b3f2",
    "syntax-string": "#a5d39b",
    "syntax-number": "#ebc487",
    "syntax-title": "#f1eeea",

    "profile-1": "#7b9cf0",
    "profile-2": "#3f9d92",
    "profile-3": "#8a72d6",
    "profile-4": "#c9a23e",
    "profile-5": "#7c93ab",
    "profile-6": "#8fa876",
  },
  // `background` is deliberately `--bg-chrome`, not `--background`: the
  // design paints the terminal's own pane a shade darker than the dock
  // column around it (same relationship as the file viewer's content area),
  // and chasing real transparency through xterm's canvas + WebGL addon never
  // closed fully anyway (see TerminalView.tsx). `black`/`cursorAccent` mirror
  // it so neither reads as a mismatched patch against the pane.
  terminal: {
    background: "#11100e",
    foreground: "#edebe8",
    cursor: "#e5642a",
    cursorAccent: "#11100e",
    selectionBackground: "rgba(229, 100, 42, 0.35)",
    black: "#11100e",
    red: "#d4614f",
    green: "#74b183",
    yellow: "#d6a24e",
    blue: "#7c93ab",
    magenta: "#8a72d6",
    cyan: "#3f9d92",
    white: "#edebe8",
    brightBlack: "#706a62",
    brightRed: "#e08175",
    brightGreen: "#9fb98a",
    brightYellow: "#e0b96e",
    brightBlue: "#9db3c9",
    brightMagenta: "#ab97e0",
    brightCyan: "#6fb8ae",
    brightWhite: "#ffffff",
  },
};

/**
 * The first light theme that ships with the app. It exists for more than
 * taste: every `appearance: "light"` path (the `dark:` variant gate, the
 * native `color-scheme`, `themeApply.ts`'s light-direction surface stack)
 * could only be reached before by importing a custom theme file, so nothing
 * in the default install ever exercised it.
 *
 * The palette is the account dashboard's, not a lightened copy of the dark
 * one — same cream/terracotta the marketing site uses, so the two halves of
 * the product look like one product.
 */
export const PAPER_THEME: Theme = {
  version: 1,
  id: "papel",
  name: "Papel",
  appearance: "light",
  colors: {
    background: "#fbfaf8",
    "bg-sidebar": "#f1eee7",
    "bg-chrome": "#f7f5f0",
    "bg-elevated": "#ffffff",
    "surface-hover": "#f1eee7",
    card: "#f4f1ea",
    "bubble-user": "#ffffff",

    foreground: "#14120f",
    "muted-foreground": "#4d4842",
    "text-faint": "#6f6960",

    primary: "#c2440f",
    "primary-foreground": "#fbfaf8",
    "primary-soft": "rgb(194 68 15 / 0.08)",
    "primary-ink": "#8f300a",
    destructive: "#b23b2a",
    "destructive-foreground": "#fbfaf8",
    "context-ring-warn": "#a1701f",
    "diff-add": "#36784b",

    border: "#e0dbd2",
    "border-soft": "#eeebe4",

    // Weaker than the dark theme's: a full-strength black scrim over a cream
    // page reads as a hole rather than as depth.
    overlay: "rgb(0 0 0 / 0.35)",
    "glass-tint": "#14120f",
    // Deliberately unchanged from the dark theme — these sit on top of the
    // user's own image, not on an app surface (see index.css).
    "media-scrim": "rgb(0 0 0 / 0.6)",
    "media-scrim-foreground": "#ffffff",
    "shadow-color": "rgb(27 25 23 / 0.14)",

    "syntax-comment": "#8a837b",
    "syntax-keyword": "#a8420f",
    "syntax-string": "#3f6b36",
    "syntax-number": "#856419",
    "syntax-title": "#3d3933",

    // Identical to the dark theme's: profile colors are the app's own
    // identity, not the theme's (same reason themeApply.ts never derives
    // them). They're already mid-tone enough to hold on either background.
    "profile-1": "#7b9cf0",
    "profile-2": "#3f9d92",
    "profile-3": "#8a72d6",
    "profile-4": "#c9a23e",
    "profile-5": "#7c93ab",
    "profile-6": "#8fa876",
  },
  terminal: {
    background: "#f1eee7",
    foreground: "#14120f",
    cursor: "#c2440f",
    cursorAccent: "#f1eee7",
    selectionBackground: "rgba(194, 68, 15, 0.25)",
    black: "#14120f",
    red: "#b23b2a",
    green: "#3f8a58",
    yellow: "#a1701f",
    blue: "#3f6486",
    magenta: "#6d4fa8",
    cyan: "#2f7a71",
    white: "#f1eee7",
    brightBlack: "#8a837b",
    brightRed: "#c2440f",
    brightGreen: "#4f9f68",
    brightYellow: "#b98429",
    brightBlue: "#4f789c",
    brightMagenta: "#8264bd",
    brightCyan: "#3f918a",
    brightWhite: "#ffffff",
  },
};

export const BUILTIN_THEMES: Theme[] = [DEFAULT_THEME, PAPER_THEME];

export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_THEMES.some((theme) => theme.id === id);
}
