import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidColorValue, parseTheme, type Theme } from "./theme.js";

function validTheme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: "nord-ish",
    name: "Nord-ish",
    appearance: "dark",
    colors: {
      background: "#2e3440",
      foreground: "#eceff4",
      "muted-foreground": "#8f9bb0",
      primary: "#88c0d0",
      destructive: "#bf616a",
      border: "#434c5e",
    },
    ...overrides,
  };
}

function errorPaths(input: unknown): string[] {
  const result = parseTheme(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors.map((error) => error.path);
}

test("accepts a minimal theme with only the required colors", () => {
  const result = parseTheme(validTheme());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.theme.id, "nord-ish");
  assert.equal(result.theme.appearance, "dark");
  assert.equal(result.theme.colors.background, "#2e3440");
  assert.equal(result.theme.terminal, undefined);
});

test("reports every problem at once instead of stopping at the first", () => {
  const paths = errorPaths({
    version: 2,
    id: "Not Valid",
    name: "",
    appearance: "sepia",
    colors: { background: "#2e3440" },
  });
  assert.deepEqual(paths.sort(), ["appearance", "colors", "id", "name", "version"]);
});

test("an invalid required color is reported once, not also as missing", () => {
  const result = parseTheme(validTheme({ colors: { ...(validTheme().colors as object), background: "url(https://x)" } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors.map((error) => error.path), ["colors.background"]);
});

test("names the missing required colors", () => {
  const result = parseTheme(validTheme({ colors: { background: "#2e3440", primary: "#88c0d0" } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const error = result.errors.find((item) => item.path === "colors");
  assert.equal(error?.code, "missing_colors");
  const missing = error?.code === "missing_colors" ? error.missing : [];
  assert.ok(missing.includes("foreground"));
  assert.ok(missing.includes("border"));
});

test("rejects an unknown token rather than silently dropping it", () => {
  const theme = validTheme();
  (theme.colors as Record<string, string>).backgruond = "#000000";
  assert.deepEqual(errorPaths(theme), ["colors.backgruond"]);
});

test("rejects reserved built-in ids", () => {
  assert.deepEqual(errorPaths(validTheme({ id: "default" })), ["id"]);
});

test("keeps an optional terminal palette and rejects unknown keys in it", () => {
  const ok = parseTheme(validTheme({ terminal: { red: "#bf616a", brightRed: "#d08770" } }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.theme.terminal?.red, "#bf616a");

  assert.deepEqual(errorPaths(validTheme({ terminal: { crimson: "#bf616a" } })), ["terminal.crimson"]);
});

test("color values: accepts the documented formats", () => {
  for (const value of [
    "#abc",
    "#abcd",
    "#2e3440",
    "#2e3440ff",
    "rgb(46 52 64)",
    "rgba(46, 52, 64, 0.5)",
    "hsl(220deg 16% 22%)",
    "oklch(0.3 0.02 260)",
    "transparent",
  ]) {
    assert.equal(isValidColorValue(value), true, value);
  }
});

test("color values: rejects anything that could reach outside the palette", () => {
  // `url(...)` is the one that matters: it's valid CSS in a background, so
  // the CSSOM would happily keep it, and applying a theme someone sent you
  // would fire an outbound request. `var()` (directly or nested) would let
  // a theme point at the app's own tokens.
  for (const value of [
    "url(https://example.com/x.png)",
    "var(--background)",
    "rgb(var(--x))",
    "red; background: url(https://example.com)",
    "",
    "#12345",
    "blue",
    `#${"a".repeat(80)}`,
  ]) {
    assert.equal(isValidColorValue(value), false, value);
  }
});

test("rejects a non-object payload", () => {
  assert.deepEqual(errorPaths("not a theme"), [""]);
  assert.deepEqual(errorPaths([validTheme()]), [""]);
  assert.deepEqual(errorPaths(null), [""]);
});

test("carries updatedAt through when present", () => {
  const result = parseTheme(validTheme({ updatedAt: "2026-09-07T12:00:00.000Z" }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal((result.theme as Theme).updatedAt, "2026-09-07T12:00:00.000Z");
});
