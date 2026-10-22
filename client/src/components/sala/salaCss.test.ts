import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A looping `transform`/`opacity` animation gets its own compositing layer in
// WebKit, and one such layer in the scaled plane left all of it painted at a
// stale scale (soft text after a zoom). Measured on macOS: edges ~2x sharper
// once the spinner stopped rotating.
const css = readFileSync(resolve(process.cwd(), "src/components/sala/sala.css"), "utf8");
/** Each rule's selector and body, comments dropped. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("sala.css", () => {
  it("has no @keyframes that animate transform or opacity", () => {
    const blocks = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, name, body] of blocks) {
      expect({ name, promotes: /(^|[\s;{])(transform|opacity)\s*:/.test(body) }).toEqual({ name, promotes: false });
    }
  });

  // The canvas's unscaled layer is what keeps a scroller or an animation
  // elsewhere in the window (the side panel's conversation) from making the
  // scaled plane a layer of its own, which WebKit paints soft.
  it("gives the canvas a compositing layer of its own", () => {
    expect(rules.find((r) => r.selector === ".sala")?.body).toMatch(/will-change:\s*transform/);
  });

  it("asks for no other compositing layer", () => {
    const promoting = rules.filter((r) => r.selector !== ".sala" && /will-change|translateZ|translate3d|backface-visibility/.test(r.body)).map((r) => r.selector);
    expect(promoting).toEqual([]);
  });
});
