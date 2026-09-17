import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The redesign's rules, as a test instead of as a convention.
 *
 * Two different things are guarded here, and they fail for two different
 * reasons. The performance rules (no animated layout property, one duration,
 * no `transition-all`) exist because the app's most frequent interactions —
 * tab switch, sidebar collapse, panel toggle — are exactly where a stray
 * `transition: width` costs a layout pass per frame; no test tier can measure
 * that (the unit tier runs under happy-dom, which has no layout engine), so
 * the grep is the guard. The vocabulary rules (square corners, one elevation)
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

/** The two files that are nothing but iOS shell. Removing one from this list
 * (because it got redesigned) is fine; adding one needs a reason that isn't
 * "the test failed". */
const MOBILE_EXCEPTIONS = new Set([
  "components/shell/MobileSidebar.tsx",
  "components/shell/MobileTopBar.tsx",
]);

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
 * Some files are only partly iOS: ChatPanel renders one mobile-only warning,
 * Composer one mobile-only branch, index.css one mobile-only rule, and
 * everything else in all three is desktop. Naming this phrase in the comment
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
  it("never animates a layout property", () => {
    // `transition-all` and a bare `transition` both reach properties that
    // force layout or paint (`all`, and Tailwind's default list, which
    // includes box-shadow and filter). The named utilities are the whole
    // allowed set: color, opacity and transform composite on the GPU.
    expect(hits(COMPONENTS, /\btransition-all\b|"transition |\btransition(?= |")/)).toEqual([]);
  });

  it("never transitions a layout property in CSS either", () => {
    // The one waiver is `.mobile-canvas` (the iOS reveal drawer), which takes
    // MOBILE_PRAGMA in index.css itself: its box-shadow/border-radius
    // transition is the settled half of a gesture whose live drag is written
    // through a ref, so it runs once when the finger lifts, not per frame.
    const banned =
      /transition(-property)?:\s*[^;]*\b(width|height|top|left|right|bottom|margin|padding|box-shadow|filter|all)\b|^\s*(width|height|top|left|right|bottom|margin|padding|box-shadow|filter)\s+[\d.]+m?s/;
    expect(hits(CSS, banned)).toEqual([]);
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
    expect(hits(COMPONENTS, rounded, (file) => MOBILE_EXCEPTIONS.has(file.path))).toEqual([]);
  });

  it("has exactly one elevation", () => {
    // `shadow-popover` is built on `--shadow-color`, so it follows the theme.
    // Tailwind's own scale (`shadow-md`, `shadow-lg`) is a fixed black that
    // disappears on a dark theme and bruises a light one. `shadow-[inset_…]`
    // isn't elevation at all — it's how the app draws an accent rule on one
    // edge (active profile, selected tab) without a border reserving space.
    const shadow = /\bshadow-(?!popover\b|\[inset)[a-z0-9[]/;
    expect(hits(COMPONENTS, shadow, (file) => MOBILE_EXCEPTIONS.has(file.path))).toEqual([]);
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
          file.path === "components/shell/AnywhLogo.tsx",
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
