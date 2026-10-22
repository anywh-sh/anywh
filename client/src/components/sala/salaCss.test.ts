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

  // The one other layer is the world's, and only while the camera moves: a pan
  // then moves one bitmap instead of painting every card's shadow and every
  // link again per frame. At rest it is gone, and the plane is painted into
  // the canvas's layer at the real scale.
  it("asks for no other compositing layer than the world's while it moves", () => {
    const promoting = rules.filter((r) => r.selector !== ".sala" && /will-change|translateZ|translate3d|backface-visibility/.test(r.body)).map((r) => r.selector);
    expect(promoting).toEqual([".sala-world.moving"]);
  });

  // A transition of `transform` or `opacity` runs on WebKit's compositor in a
  // layer of its own just as an animation does; the canvas eases them through
  // a registered number instead (`--sala-fade`, `--sala-lift`).
  it("has no transition of transform or opacity", () => {
    const easing = rules.filter((r) => /transition[^;]*(?<![\w-])(transform|opacity|translate|scale|all)(?![\w-])/.test(r.body)).map((r) => r.selector);
    expect(easing).toEqual([]);
  });

  it("registers the numbers it fades and lifts by, so they animate", () => {
    for (const name of ["--sala-fade", "--sala-lift"]) expect(css).toMatch(new RegExp(`@property ${name}\\s*\\{[^}]*syntax:\\s*"<number>"`));
  });

  // The room's motion is part of its design: nothing holds still while the
  // view moves (it is the world's layer that keeps a pan cheap).
  it("keeps every animation running while the view moves", () => {
    const paused = rules.filter((r) => /\.moving\b/.test(r.selector) && /animation/.test(r.body)).map((r) => r.selector);
    expect(paused).toEqual([]);
  });
});
