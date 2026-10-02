import { describe, expect, it } from "vitest";
import { blocksDrawerGesture } from "./drawerGestureHint";

function scroller(parent: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number }): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowX = "auto";
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  el.scrollLeft = scrollLeft;
  Object.defineProperty(el, "scrollLeft", { value: scrollLeft, configurable: true });
  parent.append(el);
  return el;
}

describe("blocksDrawerGesture", () => {
  it("does not block outside any scroller", () => {
    const el = document.createElement("p");
    document.body.append(el);
    expect(blocksDrawerGesture(el)).toBe(false);
    expect(blocksDrawerGesture(null)).toBe(false);
  });

  it("does not block a scroller sitting at its start", () => {
    const block = scroller(document.body, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
    const inner = document.createElement("span");
    block.append(inner);
    expect(blocksDrawerGesture(inner)).toBe(false);
  });

  it("blocks a scroller that has already scrolled", () => {
    const block = scroller(document.body, { scrollWidth: 500, clientWidth: 200, scrollLeft: 40 });
    const inner = document.createElement("span");
    block.append(inner);
    expect(blocksDrawerGesture(inner)).toBe(true);
  });

  it("ignores an overflow container whose content fits", () => {
    const block = scroller(document.body, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });
    expect(blocksDrawerGesture(block)).toBe(false);
  });

  it("only the nearest scroller counts", () => {
    const outer = scroller(document.body, { scrollWidth: 900, clientWidth: 300, scrollLeft: 80 });
    const inner = scroller(outer, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
    expect(blocksDrawerGesture(inner)).toBe(false);
  });
});
