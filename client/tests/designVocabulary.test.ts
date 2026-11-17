import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The redesign's rules, as a test instead of as a convention.
 *
 * Two different things are guarded here, and they fail for two different
 * reasons. The performance rules (durations from the tokens, no
 * `transition-all`) exist because the app's most frequent interactions — tab
 * switch, sidebar collapse, panel toggle — are exactly where a stray
 * `transition: all` costs a layout pass per frame; no test tier can measure
 * that (the unit tier runs under happy-dom, which has no layout engine), so
 * the grep is the guard.
 *
 * Motion is welcome; what is not is motion that costs performance. Animating a
 * layout property (a panel's width) is allowed where it is one contained box
 * whose content does not re-wrap on the way — see `SessionDock` — and is the
 * author's to justify. What the greps below still forbid is the careless
 * forms: `transition-all`, a bare `transition`, a hand-written duration. The vocabulary rules (square corners, one elevation)
 * exist because a `rounded-md` copied from a shadcn snippet is invisible in
 * review and permanent once merged.
 *
 * Scope note: the iOS shell is exempt from the shape rules, and only from
 * those. It kept its pre-existing layout — rounded cards, a pill-shaped
 * floating top bar, glass chrome that lifts off the content — because the
 * redesign covered desktop only; repainting half of a screen that nobody can
 * validate from a Linux box produces a worse result than leaving it whole.
 */
// Resolved from the runner's cwd (always `client/`, where vitest.config.ts
// lives) — same reasoning as builtinThemes.test.ts's read of index.css.
const SRC = resolve(process.cwd(), "src");

interface SourceFile {
  path: string;
  text: string;
}

function collect(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
      continue;
    }
    if (![".ts", ".tsx", ".css"].includes(extname(entry))) continue;
    if (entry.includes(".test.")) continue;
    out.push({ path: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
  }
  return out;
}

const FILES = collect(SRC);
const COMPONENTS = FILES.filter((file) => file.path.endsWith(".tsx"));
const CSS = FILES.filter((file) => file.path.endsWith(".css"));

/**
 * A file that is only partly iOS can waive a rule on a mobile-only line
 * (none do today: the iOS composer, banners and chrome are native). Naming this phrase in the comment
 * just above the exempt line is the opt-out, so a waiver costs a sentence
 * saying which rule is being waived and why. The window is six lines: enough
 * to clear the `{isIOS() && …}` line that usually separates the comment from
 * the className it explains, and no more.
 */
const MOBILE_PRAGMA = "iOS shell, not redesigned";

/** `file:line` for every line matching `pattern`, so a failure names the spot
 * instead of just the rule. */
function hits(files: SourceFile[], pattern: RegExp, skip?: (file: SourceFile) => boolean): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (skip?.(file)) continue;
    const lines = file.text.split("\n");
    lines.forEach((line, index) => {
      // A line that only documents a rule (the comment explaining why
      // `transition-all` is banned) must not trip the rule it documents.
      const code = line.replace(/^\s*(\/\/|\/?\*).*/, "");
      if (!pattern.test(code)) return;
      if (lines.slice(Math.max(0, index - 6), index).some((above) => above.includes(MOBILE_PRAGMA))) return;
      found.push(`${file.path}:${String(index + 1)} ${line.trim()}`);
    });
  }
  return found;
}

describe("motion budget", () => {
  it("never reaches for every property at once", () => {
    // `transition-all` and a bare `transition` both reach properties that
    // force layout or paint (`all`, and Tailwind's default list, which
    // includes box-shadow and filter) — including ones nobody meant to
    // animate. Name what moves: `transition-colors`, `-opacity`, `-transform`,
    // or, for a panel opening, `transition-[width]` on a contained box.
    expect(hits(COMPONENTS, /\btransition-all\b|"transition |\btransition(?= |")/)).toEqual([]);
  });

  it("never transitions a layout property in CSS either", () => {
    const banned =
      /transition(-property)?:\s*[^;]*\b(width|height|top|left|right|bottom|margin|padding|box-shadow|filter|all)\b|^\s*(width|height|top|left|right|bottom|margin|padding|box-shadow|filter)\s+[\d.]+m?s/;
    // The room canvas is the one exception, by design: its cards carry a
    // shadow that deepens when one is picked up, and its areas ease to a new
    // place and size. sala.css's header says how that stays cheap, and
    // salaCss.test.ts guards what it can never do (a `transform`/`opacity`
    // transition, a layer in the plane).
    expect(hits(CSS, banned, (file) => file.path.endsWith(`components${sep}sala${sep}sala.css`))).toEqual([]);
  });

  it("takes its duration from the token instead of writing one by hand", () => {
    // `--default-transition-duration` is wired to `--motion-fast` in
    // index.css, so a bare `transition-colors` already carries the budget.
    // A hand-written `duration-300` is how a surface silently opts out of it.
    expect(hits(COMPONENTS, /\bduration-(?!\(--)[0-9[]/)).toEqual([]);
  });

  it("does not carry utilities from an animation plugin this project never installed", () => {
    // `animate-in`, `slide-in-from-right`, `zoom-in-95` and friends come from
    // `tw-animate-css`, which the shadcn scaffold assumes and this project
    // does not depend on. Under Tailwind v4 an unknown utility generates
    // nothing at all — so these classes have never animated anything here.
    // They read like intent in review, which is worse than absent.
    const dead = /\b(animate-(in|out)|fade-(in|out)-|zoom-(in|out)-|slide-(in-from|out-to)-)/;
    expect(hits(COMPONENTS, dead)).toEqual([]);
  });
});

describe("shape vocabulary", () => {
  it("keeps every corner square", () => {
    // `--radius: 0` is the whole visual identity. `rounded-full` survives
    // only where the shape is genuinely a circle — a status dot, a spinner.
    const rounded = /\brounded-(?!full\b)[a-z0-9[]/;
    expect(hits(COMPONENTS, rounded)).toEqual([]);
  });

  it("has exactly two elevations, both themed", () => {
    // `shadow-popover` (anything that floats) and `shadow-lift` (the new-session
    // composer) are both built on `--shadow-color`, so it follows the theme.
    // Tailwind's own scale (`shadow-md`, `shadow-lg`) is a fixed black that
    // disappears on a dark theme and bruises a light one. `shadow-[inset_…]`
    // isn't elevation at all — it's how the app draws an accent rule on one
    // edge (active profile, selected tab) without a border reserving space.
    const shadow = /\bshadow-(?!popover\b|lift\b|\[inset)[a-z0-9[]/;
    expect(hits(COMPONENTS, shadow)).toEqual([]);
  });
});

describe("color and type", () => {
  it("keeps color literals out of components", () => {
    // A hex inside a component is out of reach of every theme — which is the
    // entire reason `--overlay`/`--glass-tint`/`--syntax-*` exist as tokens.
    // The themes themselves (builtinThemes.ts) are where hex belongs.
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const themeData = new Set(["lib/theme/builtinThemes.ts", "lib/theme/themeApply.ts"]);
    expect(
      hits(
        FILES.filter((file) => !file.path.endsWith(".css")),
        hex,
        (file) =>
          themeData.has(file.path) ||
          // ThemeImportDialog's placeholder is a sample theme file — the hex
          // in it is the content being illustrated, not a color being applied.
          file.path === "components/settings/ThemeImportDialog.tsx" ||
          // The brand mark's two colors are fixed regardless of theme (same
          // two hexes as the static `assets/logo.svg`) — a token would imply
          // they're themeable, which is exactly what they must not be.
          file.path === "components/shell/AnywhLogo.tsx" ||
          // Claude's mark keeps its fixed brand orange for the same reason:
          // it identifies a vendor's product and must not follow the theme.
          file.path === "components/chat/AgentLogo.tsx",
      ),
    ).toEqual([]);
  });

  it("never names a pre-redesign font", () => {
    // Inter and JetBrains Mono were the scaffold's fonts. They're gone from
    // package.json; a leftover name in a font stack would silently win on any
    // machine that happens to have them installed.
    expect(hits(FILES, /\b(Inter|JetBrains Mono)\b/)).toEqual([]);
  });
});

describe("onboarding", () => {
  it("writes labels in sentence case, never shouted", () => {
    // The onboarding's labels keep only the first letter capitalized — an
    // `uppercase` class turns "Pairing code" into a heading it isn't.
    const firstrun = COMPONENTS.filter((file) => file.path.startsWith("components/firstrun/"));
    expect(hits(firstrun, /\buppercase\b/)).toEqual([]);
  });
});

/**
 * Raw `<button>` elements still carrying their own classes, per file, frozen
 * at the count they had when `Button` became the rule (AGENTS.md, "Primitivos
 * de UI"). It is a ratchet: a file not listed here may not add one, a listed
 * file may not go above its count, and a file that drops below it fails too,
 * so the list is lowered in the same change that migrates a button and never
 * leaves slack for a new one to slip in. Not every entry has to end up as a
 * `Button` — a clickable row or tab is a button semantically but not
 * visually; those leave the list by gaining their own primitive in
 * `components/ui/`, not by staying hand-styled.
 */
const RAW_BUTTON_BASELINE: Record<string, number> = {
  "components/files/DownloadToasts.tsx": 1,
  "components/firstrun/AdvancedOptions.tsx": 1,
  "components/firstrun/AgentsScreen.tsx": 1,
  "components/firstrun/CommandLine.tsx": 1,
  "components/firstrun/OnboardingFrame.tsx": 1,
  "components/firstrun/Preparing.tsx": 2,
  "components/firstrun/QuietLink.tsx": 1,
  "components/settings/AppearanceSettings.tsx": 1,
  "components/settings/ProfileSettings.tsx": 2,
  "components/settings/SettingsNav.tsx": 2,
  "components/settings/ThemeSection.tsx": 3,
};

/**
 * Hand-rolled loading indicators (`animate-spin` on a `Loader2` icon or on a
 * bordered span), per file, frozen when `Spinner` became the one indicator.
 * Same ratchet as the button baseline above.
 */
const RAW_SPINNER_BASELINE: Record<string, number> = {
  "components/files/DownloadToasts.tsx": 1,
};

/**
 * Files git tracks under `src/`, relative to it. The ratchets compare against
 * a checked-in baseline, so they must see exactly what CI sees: a prototype
 * kept out of the repo through `.git/info/exclude` would otherwise count
 * locally and be missing in CI (or the reverse), and the baseline could never
 * be right in both places at once. `null` outside a git checkout, where
 * everything on disk counts.
 */
const TRACKED: Set<string> | null = (() => {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: SRC, encoding: "utf8" });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
})();

/** Occurrences of `pattern` per tracked component file outside `components/ui/`. */
function countsOutsidePrimitives(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of COMPONENTS) {
    if (file.path.startsWith("components/ui/") || file.path.includes(".stories.")) continue;
    if (TRACKED && !TRACKED.has(file.path)) continue;
    const count = file.text.match(pattern)?.length ?? 0;
    if (count > 0) counts[file.path] = count;
  }
  return counts;
}

/** Files above their baseline (the rule was broken) and files below it (the
 * baseline went slack and must be lowered). */
function ratchet(actual: Record<string, number>, baseline: Record<string, number>) {
  const describe = (path: string, count: number, base: number) => `${path}: ${String(count)} (baseline ${String(base)})`;
  return {
    grew: Object.entries(actual)
      .filter(([path, count]) => count > (baseline[path] ?? 0))
      .map(([path, count]) => describe(path, count, baseline[path] ?? 0)),
    stale: Object.entries(baseline)
      .filter(([path, count]) => (actual[path] ?? 0) < count)
      .map(([path, count]) => describe(path, actual[path] ?? 0, count)),
  };
}

/**
 * Elements made clickable with `role="button"`, the other way to hand-roll a
 * button: it dodges the `<button>` count above, and carries a hand-written
 * keyboard handler besides. Same ratchet. Usually the reason was a control
 * nested inside (a tab and its ×); the way out is the trigger and the control
 * as siblings, as `TabTrigger` does.
 */
const ROLE_BUTTON_BASELINE: Record<string, number> = {
  "components/files/FileTree.tsx": 1,
};

/**
 * Buttons drawn inside the room canvas's zoomed plane (a card's hit area and
 * actions, a subtask's, an area's ×, the answer anchored under a card). Not
 * a pending migration: these stay in `sala.css`, whose header says why — in
 * the plane, what is composited and repainted per frame is the point, and a
 * primitive's transitions, ring and class list would change it out of
 * sight. Everything the room draws outside the plane (toolbar, selection
 * bar, toast, side panel, launcher) is built from primitives. Same ratchet:
 * the plane may not gain a hand-styled button either.
 */
const CANVAS_PLANE_BUTTONS: Record<string, number> = {
  "components/sala/AgentAnswer.tsx": 1,
  "components/sala/SalaCanvas.tsx": 1,
  "components/sala/SalaCard.tsx": 7,
  "components/sala/SalaSubtaskCard.tsx": 4,
};

const rawButtons = () =>
  ratchet(countsOutsidePrimitives(/<button(?=[\s>])/g), { ...RAW_BUTTON_BASELINE, ...CANVAS_PLANE_BUTTONS });
const roleButtons = () => ratchet(countsOutsidePrimitives(/role="button"/g), ROLE_BUTTON_BASELINE);
const rawSpinners = () => ratchet(countsOutsidePrimitives(/\banimate-spin\b/g), RAW_SPINNER_BASELINE);

describe("primitives", () => {
  it("builds controls from components/ui instead of a hand-styled <button>", () => {
    // A raw `<button>` with its own classes is out of reach of every change
    // to `Button` — which is how the app ended up with buttons that drift.
    // Use `Button` (add a variant if none fits), or give the pattern its own
    // primitive in `components/ui/` with a story.
    expect(rawButtons().grew).toEqual([]);
  });

  it("keeps the raw <button> baseline tight", () => {
    // A migrated file lowers its entry (or drops it) in the same change, so
    // the slack it freed can't be spent by the next hand-styled button.
    expect(rawButtons().stale).toEqual([]);
  });

  it("keeps the canvas's declared buttons apart from the pending ones", () => {
    // Merged into one baseline below, so a file in both would lose a count.
    expect(Object.keys(CANVAS_PLANE_BUTTONS).filter((path) => path in RAW_BUTTON_BASELINE)).toEqual([]);
  });

  it("never fakes a button with role=\"button\"", () => {
    expect(roleButtons().grew).toEqual([]);
  });

  it("keeps the role=\"button\" baseline tight", () => {
    expect(roleButtons().stale).toEqual([]);
  });

  it("shows loading with Spinner instead of a hand-rolled animate-spin", () => {
    // Before Spinner there were two drawings (a Loader2 icon and a bordered
    // ring) in five sizes and three border widths. `Spinner` has the sizes
    // and tones; `Button` has `loading`.
    expect(rawSpinners().grew).toEqual([]);
  });

  it("keeps the raw spinner baseline tight", () => {
    expect(rawSpinners().stale).toEqual([]);
  });
});
