import "@testing-library/jest-dom/vitest";

// happy-dom (like jsdom) has no real layout engine — every element's
// getBoundingClientRect() reports all-zero dimensions. @tanstack/react-virtual
// (MessageLog.tsx) uses that measurement to decide which rows are "in view",
// so without this, a virtualized list always computes zero rows in range and
// renders empty regardless of how many entries are actually in state — a
// real trap hit while building the client/tests/ui tier (a full send-message
// flow looked like it silently dropped the reply). Fixed height is arbitrary,
// just needs to be nonzero and bigger than a row.
Element.prototype.getBoundingClientRect = () =>
  ({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  });

// getBoundingClientRect alone wasn't enough: react-virtual's own size
// tracking is driven by ResizeObserver, and happy-dom's implementation never
// actually fires a callback (no real layout engine to detect a resize
// against) — so the virtualizer's internal "how tall is the scroll
// container" state stayed stuck at zero and it always computed an empty
// visible range, even once getBoundingClientRect above reported a real size.
// This fires every observed target's callback once, synchronously, with that
// same size.
class FakeResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const rect = target.getBoundingClientRect();
    this.callback(
      [{ target, contentRect: rect } as ResizeObserverEntry],
      this,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = FakeResizeObserver;

// The actual measurement @tanstack/virtual-core reads on every call (its own
// getRect, virtual-core/dist/esm/index.js) is offsetWidth/offsetHeight, NOT
// getBoundingClientRect — the two stubs above were necessary but not
// sufficient; without this one too, the scroll container still measured as
// 0x0 and every row stayed out of the computed visible range.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });

// Same story, different reader: useGroupSizeDrag/useSplitDrag measure their
// container via clientWidth/clientHeight (not offsetWidth/offsetHeight) at
// drag start — without this, happy-dom reports 0, and the drag hook's own
// `if (containerWidth === 0) return` guard would silently no-op every
// simulated drag in tests/ui/tabGroups.test.tsx.
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
