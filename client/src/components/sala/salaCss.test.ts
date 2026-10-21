import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A looping `transform`/`opacity` animation gets its own compositing layer in
// WebKit, and one such layer in the scaled plane left all of it painted at a
// stale scale (soft text after a zoom). Measured on macOS: edges ~2x sharper
// once the spinner stopped rotating.
describe("sala.css", () => {
  it("has no @keyframes that animate transform or opacity", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/sala/sala.css"), "utf8");
    const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, name, body] of blocks) {
      expect({ name, promotes: /(^|[\s;{])(transform|opacity)\s*:/.test(body) }).toEqual({ name, promotes: false });
    }
  });
});
