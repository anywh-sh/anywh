import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DOCK_RAIL_WIDTH, SessionDock } from "@/components/shell/SessionDock";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DockState } from "@/hooks/tabs/useSessionDock";

afterEach(() => cleanup());

const open: DockState = { panes: ["files"], width: 420, maximized: null };
const closed: DockState = { ...open, panes: [] };
const noop = vi.fn();

// jsdom has no layout, so every rect is zero. The cut follows the width the
// dock has on screen, so give a dock the width its style says it has: the
// panel's plus the rail's, or the rail's alone when closed. (The real thing
// is measured in a browser.)
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const width = this.hasAttribute("data-dock-edge") ? Number(this.style.width.replace("px", "")) || 0 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, height: 0, width, toJSON: () => ({}) };
    },
  });
});
afterEach(() => {
  // Takes the stub off `HTMLElement.prototype`, leaving the real one on `Element`.
  delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

// The plane's frame and the status bar belong to the shell, outside the dock.
// jsdom has no layout (every rect is zero), so "the dock touches the plane's
// right edge" holds here, which is the one-group case this is about.
function renderDock(dock: DockState) {
  return render(
    <TooltipProvider><div>
      <div data-plane-frame />
      <div data-status-bar />
      <SessionDock dock={dock} onWidthChange={noop} onDragEnd={noop} groupId={null} onTogglePanel={noop} panes={{ files: <div /> }} />
    </div></TooltipProvider>,
  );
}

const frame = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-plane-frame]")!;
const statusBar = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-status-bar]")!;
const edge = (container: HTMLElement) => container.querySelector("[data-dock-edge]");

describe("useDockFrameCut", () => {
  it("gives the frame the dock's width, rail included, when it is open at the right edge", () => {
    const { container } = renderDock(open);
    expect(edge(container)).not.toBeNull();
    expect(frame(container).style.getPropertyValue("--dock-side-w")).toBe(`${420 + DOCK_RAIL_WIDTH}px`);
  });

  // The status bar's rule runs the window's width, under the dock too.
  it("leaves the status bar whole", () => {
    const { container } = renderDock(open);
    expect(statusBar(container).style.getPropertyValue("--dock-side-w")).toBe("");
  });

  // The rail stays beside the plane with the panel closed, outside its frame.
  it("cuts the rail's width while the dock is closed", () => {
    const { container } = renderDock(closed);
    expect(edge(container)).not.toBeNull();
    expect(frame(container).style.getPropertyValue("--dock-side-w")).toBe(`${DOCK_RAIL_WIDTH}px`);
  });

  it("follows the dock's width", () => {
    const { container, rerender } = renderDock(open);
    rerender(
      <TooltipProvider><div>
        <div data-plane-frame />
        <div data-status-bar />
        <SessionDock dock={{ ...open, width: 560 }} onWidthChange={noop} onDragEnd={noop} groupId={null} onTogglePanel={noop} panes={{ files: <div /> }} />
      </div></TooltipProvider>,
    );
    expect(frame(container).style.getPropertyValue("--dock-side-w")).toBe(`${560 + DOCK_RAIL_WIDTH}px`);
  });

  // A maximized pane fills the plane: there is no side to be docked on.
  it("cuts nothing for a maximized pane", () => {
    const { container } = renderDock({ ...open, maximized: "files" });
    expect(edge(container)).toBeNull();
    expect(frame(container).style.getPropertyValue("--dock-side-w")).toBe("0px");
  });

  it("gives the frame back when the dock goes away", () => {
    const { container, unmount } = renderDock(open);
    const plane = frame(container);
    unmount();
    expect(plane.style.getPropertyValue("--dock-side-w")).toBe("0px");
  });
});

describe("useDockFrameCut — while the dock slides", () => {
  it("follows the dock down to the rail as it closes", async () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderDock(open);
      rerender(
        <TooltipProvider><div>
          <div data-plane-frame />
          <div data-status-bar />
          <SessionDock dock={closed} onWidthChange={noop} onDragEnd={noop} groupId={null} onTogglePanel={noop} panes={{ files: <div /> }} />
        </div></TooltipProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(edge(container)).not.toBeNull();
      expect(frame(container).style.getPropertyValue("--dock-side-w")).toBe(`${DOCK_RAIL_WIDTH}px`);
    } finally {
      vi.useRealTimers();
    }
  });
});
