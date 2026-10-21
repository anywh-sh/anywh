import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SalaCanvas, type SalaCanvasProps } from "@/components/sala/SalaCanvas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RoomAgent, RoomCanvas } from "@/lib/relay/roomClient";

afterEach(cleanup);

function agent(agentId: string, over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId, role: "worker", parentId: "main", title: agentId, runtime: "claude", model: "haiku", createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over };
}

const agents = [agent("main", { role: "principal", parentId: undefined }), agent("a"), agent("b")];

/** Camera at 100%, origin at the top-left: a pixel is a world unit. */
function canvasOf(over: Partial<RoomCanvas> = {}): RoomCanvas {
  return {
    positions: { main: { x: 240, y: 24 }, a: { x: 24, y: 288 }, b: { x: 312, y: 288 } },
    areas: [],
    texts: [],
    camera: { x: 0, y: 0, zoom: 1 },
    ...over,
  };
}

function mount(canvas: RoomCanvas, props: Partial<SalaCanvasProps> = {}) {
  const onCanvasChange = vi.fn();
  const onCameraSettled = vi.fn();
  render(
    <TooltipProvider>
      <SalaCanvas
        agents={agents}
        since={new Map()}
        canvas={canvas}
        modelLabelOf={(a) => a.model ?? ""}
        reconnecting={false}
        saveFailed={false}
        onCanvasChange={onCanvasChange}
        onCameraSettled={onCameraSettled}
        onOpenAgent={vi.fn()}
        onNewAgent={vi.fn()}
        newAgentOpen={false}
        launcher={null}
        onAbout={vi.fn()}
        aboutVisible
        renderAnswer={() => null}
        onEscape={vi.fn()}
        onStopAgent={() => Promise.resolve(true)}
        onRemoveAgent={() => Promise.resolve({ undoMs: 1000 })}
        onRestoreAgent={() => Promise.resolve(true)}
        onAttachFiles={() => Promise.resolve(true)}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onCanvasChange, onCameraSettled, viewport: screen.getByTestId("sala-canvas") };
}

const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agent-id="${id}"]`)!;
const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", target: Element, x: number, y: number): void => {
  fireEvent[type](target, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true });
};

describe("SalaCanvas — dragging a card", () => {
  it("snaps a dropped card to the 24px grid and saves it, leaving every other card alone", () => {
    const { onCanvasChange, viewport } = mount(canvasOf());
    const body = card("a").querySelector(".sala-node-body")!;
    pointer("pointerDown", body, 100, 340);
    pointer("pointerMove", viewport, 150, 360);
    pointer("pointerMove", viewport, 197, 393);
    pointer("pointerUp", viewport, 197, 393);
    expect(onCanvasChange).toHaveBeenCalledTimes(1);
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    // 24 + 97 = 121 -> 120; 288 + 53 = 341 -> 336.
    expect(saved.positions.a).toEqual({ x: 120, y: 336 });
    expect(saved.positions.b).toEqual({ x: 312, y: 288 });
    expect(saved.positions.main).toEqual({ x: 240, y: 24 });
    expect(card("a").style.transform).toBe("translate(120px, 336px)");
  });

  it("follows the pointer while it moves, before anything is saved", () => {
    const { onCanvasChange, viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerMove", viewport, 140, 340);
    pointer("pointerMove", viewport, 160, 360);
    expect(card("a").style.transform).toBe("translate(84px, 308px)");
    expect(card("a")).toHaveAttribute("data-drag");
    expect(onCanvasChange).not.toHaveBeenCalled();
  });

  it("treats a click that never moved as a selection, not a move", () => {
    const { onCanvasChange, viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerUp", viewport, 100, 340);
    expect(onCanvasChange).not.toHaveBeenCalled();
    expect(card("a").className).toContain("sel");
  });

  it("puts everything back when the system takes the pointer mid-drag, and saves nothing", () => {
    const { onCanvasChange, viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerMove", viewport, 140, 340);
    pointer("pointerMove", viewport, 300, 500);
    expect(card("a").style.transform).not.toBe("translate(24px, 288px)");
    pointer("pointerCancel", viewport, 300, 500);
    expect(onCanvasChange).not.toHaveBeenCalled();
    expect(card("a").style.transform).toBe("translate(24px, 288px)");
    expect(card("a")).not.toHaveAttribute("data-drag");
  });

  it("ignores a second pointer while one is dragging", () => {
    const { onCanvasChange, viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerMove", viewport, 160, 400);
    fireEvent.pointerDown(viewport, { clientX: 600, clientY: 100, pointerId: 2, button: 0 });
    pointer("pointerMove", viewport, 184, 424);
    pointer("pointerUp", viewport, 184, 424);
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    // 24 + 84 = 108 -> 120 (4.5 rounds up); 288 + 84 = 372 -> 384.
    expect(saved.positions.a).toEqual({ x: 120, y: 384 });
  });
});

describe("SalaCanvas — areas", () => {
  const area = { id: "x", label: "Design", x: 0, y: 0, members: ["a", "b"] };

  it("draws an area around its members with their count, and takes a card in when it is dropped over it", () => {
    const { onCanvasChange, viewport } = mount(canvasOf({ areas: [area] }));
    const frame = document.querySelector<HTMLElement>('[data-area-id="x"]')!;
    expect(frame.style.transform).toBe("translate(0px, 264px)");
    expect(frame).toHaveTextContent("2 agents");
    // The principal is dragged onto the area: it changes area.
    pointer("pointerDown", card("main").querySelector(".sala-node-body")!, 300, 80);
    pointer("pointerMove", viewport, 300, 200);
    pointer("pointerMove", viewport, 100, 340);
    pointer("pointerUp", viewport, 100, 340);
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.areas[0].members).toContain("main");
  });

  it("stores an area with the frame it draws now, so it does not fall back to where it began", () => {
    const { onCanvasChange } = mount(canvasOf({ areas: [{ ...area, x: 9999, y: 9999 }] }));
    fireEvent.blur(document.querySelector<HTMLInputElement>('[data-area-id="x"] input')!, { target: { value: "Renamed" } });
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.areas[0]).toMatchObject({ label: "Renamed", x: 0, y: 264 });
  });

  it("keeps a name inside what the relay accepts", () => {
    mount(canvasOf({ areas: [area] }));
    expect(document.querySelector('[data-area-id="x"] input')).toHaveAttribute("maxlength", "200");
  });

  it("removes an area and leaves its agents", () => {
    const { onCanvasChange } = mount(canvasOf({ areas: [area] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove area (the agents stay)" }));
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.areas).toEqual([]);
    expect(Object.keys(saved.positions).sort()).toEqual(["a", "b", "main"]);
  });
});

describe("SalaCanvas — text", () => {
  const text = { id: "t", text: "Notes", x: 240, y: 240 };

  it("keeps a text where it is drawn while it is dragged and when it is dropped (its box sits above its y)", () => {
    const { onCanvasChange, viewport } = mount(canvasOf({ texts: [text, { id: "u", text: "second", x: 480, y: 240 }] }));
    const second = document.querySelector<HTMLElement>('[data-text-id="u"]')!;
    // The first text is a heading (42 above), the others 22.
    expect(document.querySelector<HTMLElement>('[data-text-id="t"]')!.style.transform).toBe("translate(240px, 198px)");
    expect(second.style.transform).toBe("translate(480px, 218px)");
    pointer("pointerDown", second.querySelector("input")!, 500, 230);
    pointer("pointerMove", viewport, 520, 260);
    pointer("pointerMove", viewport, 548, 278);
    expect(second.style.transform).toBe("translate(528px, 266px)");
    pointer("pointerUp", viewport, 548, 278);
    expect(second.style.transform).toBe("translate(528px, 266px)");
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.texts[1]).toEqual({ id: "u", text: "second", x: 528, y: 288 });
  });

  it("drops a text that was emptied, and keeps what the relay accepts", () => {
    const { onCanvasChange } = mount(canvasOf({ texts: [text] }));
    const input = document.querySelector<HTMLInputElement>('[data-text-id="t"] input')!;
    expect(input).toHaveAttribute("maxlength", "4000");
    fireEvent.blur(input, { target: { value: "   " } });
    expect((onCanvasChange.mock.calls[0][0] as RoomCanvas).texts).toEqual([]);
  });
});

describe("SalaCanvas — camera and keyboard", () => {
  it("holds what loops in the background still while the view is dragged, and lets go after", () => {
    const { viewport } = mount(canvasOf());
    const world = document.querySelector(".sala-world")!;
    pointer("pointerDown", viewport, 700, 500);
    pointer("pointerMove", viewport, 730, 500);
    pointer("pointerMove", viewport, 760, 510);
    expect(world).toHaveClass("moving");
    expect(viewport).toHaveAttribute("data-panning");
    expect((world as HTMLElement).style.transform).toContain("translate(60px, 10px)");
    pointer("pointerUp", viewport, 760, 510);
    expect(viewport).not.toHaveAttribute("data-panning");
  });

  it("shows the zoom and moves in the toolbar's steps", () => {
    mount(canvasOf());
    expect(screen.getByRole("button", { name: /back to 100%/ })).toHaveTextContent("100%");
  });

  it("does not take Space or Enter from a focused button", () => {
    const { viewport } = mount(canvasOf());
    const button = screen.getByRole("button", { name: "Text" });
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const onViewport = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    viewport.dispatchEvent(onViewport);
    expect(onViewport.defaultPrevented).toBe(true);
  });

  it("does not offer to save a camera it restored on its own", () => {
    const { onCameraSettled } = mount(canvasOf());
    expect(onCameraSettled).not.toHaveBeenCalled();
  });

  it("opens on all of the room when the saved camera looks at empty canvas", () => {
    const { onCameraSettled } = mount(canvasOf({ camera: { x: -90000, y: -90000, zoom: 1 } }));
    // Fitting a room by itself is not a choice of the person's: nothing is saved.
    expect(onCameraSettled).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".sala-world")!.style.transform).not.toContain("-90000");
  });

  it("says a refused save did not go through", () => {
    mount(canvasOf(), { saveFailed: true });
    expect(screen.getByRole("status")).toHaveTextContent("The layout could not be saved.");
  });
});

describe("SalaCanvas — a title still being generated", () => {
  it("draws a placeholder on the card instead of the provisional text, and the text once it arrives", () => {
    const pending = [agent("main", { role: "principal", parentId: undefined }), agent("a", { title: "Investigate why the websocket reconnect loop spins", titlePending: true }), agent("b")];
    mount(canvasOf(), { agents: pending });
    expect(card("a").textContent).not.toContain("Investigate why");
    expect(card("a").querySelector('[role="status"]')).not.toBeNull();
    expect(card("b").querySelector('[role="status"]')).toBeNull();
    cleanup();
    mount(canvasOf(), { agents: [pending[0], agent("a", { title: "Reconnect loop" }), pending[2]] });
    expect(card("a").textContent).toContain("Reconnect loop");
    expect(card("a").querySelector('[role="status"]')).toBeNull();
  });
});
