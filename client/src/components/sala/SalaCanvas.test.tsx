import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SalaCanvas, type SalaCanvasProps } from "@/components/sala/SalaCanvas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RoomAgent, RoomCanvas, RoomWorktree } from "@/lib/relay/roomClient";

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
  const tree = (over: Partial<SalaCanvasProps>) => (
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
        onSelectMany={vi.fn()}
        onStopAgent={() => Promise.resolve(true)}
        onRemoveAgent={() => Promise.resolve({ undoMs: 1000 })}
        onRestoreAgent={() => Promise.resolve(true)}
        onCheckWork={() => Promise.resolve([])}
        onAttachFiles={() => Promise.resolve(true)}
        {...props}
        {...over}
      />
    </TooltipProvider>
  );
  const { rerender } = render(tree({}));
  return { onCanvasChange, onCameraSettled, viewport: screen.getByTestId("sala-canvas"), rerender: (over: Partial<SalaCanvasProps>) => rerender(tree(over)) };
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
    expect([frame.style.left, frame.style.top]).toEqual(["0px", "264px"]);
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
  it("makes the world a layer of its own while the view is dragged, and lets go after", () => {
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

  it("lays the plane out at the zoom once a zoom settles, with no scale left in a transform", () => {
    vi.useFakeTimers();
    try {
      mount(canvasOf());
      const world = document.querySelector<HTMLElement>(".sala-world")!;
      const plane = document.querySelector<HTMLElement>(".sala-plane")!;
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      vi.advanceTimersByTime(1000);
      expect(plane.style.zoom).toBe("1.25");
      expect(world.style.transform).not.toContain("scale");
    } finally {
      vi.useRealTimers();
    }
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

  it("names the principal Orchestrator, never by its generated title nor with a placeholder", () => {
    mount(canvasOf(), { agents: [agent("main", { role: "principal", parentId: undefined, title: "Profile page", titlePending: true }), agents[1], agents[2]] });
    expect(card("main").querySelector(".sala-title")).toHaveTextContent("Orchestrator");
    expect(card("main").textContent).not.toContain("Profile page");
    expect(card("main").textContent).not.toContain("Main");
    expect(card("main").querySelector('[role="status"]')).toBeNull();
  });
});

describe("SalaCanvas — what a running card's lines say", () => {
  it("words each action like the conversation's Working block, the newest on the last line", () => {
    const worker = agent("a", {
      startedAt: 10_000,
      activity: [
        { id: "1", verb: "mcp", target: "linear.get_issue", startedAt: 10_000, endedAt: 40_000 },
        { id: "2", verb: "read", target: "socket.ts", startedAt: 40_000, endedAt: 55_000 },
        { id: "3", verb: "think", startedAt: 55_000 },
      ],
    });
    mount(canvasOf(), { agents: [agents[0], worker, agents[2]] });
    const rows = [...card("a").querySelectorAll(".sala-line")].map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe("0:30Queried linear.get_issue");
    expect(rows[1]).toBe("0:45Read socket.ts");
    expect(rows[2]).toContain("Thinking");
  });
});

describe("SalaCanvas — motion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const edge = (id: string): SVGPathElement => document.querySelector<SVGPathElement>(`.sala-edge[data-edge="${id}"]`)!;
  const pulse = (id: string): Element | null => document.querySelector(`.sala-edge-pulse[data-edge="${id}"]`);
  const bar = (): HTMLElement | null => document.querySelector<HTMLElement>(".sala-bar");
  const withC = canvasOf({ positions: { ...canvasOf().positions, c: { x: 24, y: 552 } } });

  it("draws each link in its child's state, with a glint along a running one only", () => {
    const list = [agents[0], agent("a"), agent("b", { state: "awaiting_user" }), agent("c", { state: "done" })];
    mount(canvasOf({ positions: { ...canvasOf().positions, c: { x: 600, y: 288 } } }), { agents: list });
    expect(edge("a")).toHaveClass("run");
    expect(edge("b")).toHaveClass("wait");
    expect(edge("c")).toHaveClass("done");
    expect(pulse("a")).not.toBeNull();
    expect(pulse("b")).toBeNull();
    expect(pulse("c")).toBeNull();
    // Dashes are measured against the path's own length.
    expect(edge("a").style.getPropertyValue("--len")).toMatch(/^\d+(\.\d)?px$/);
  });

  it("marks the links to the selected card's children as well as to its parent", () => {
    const { viewport } = mount(withC, { agents: [...agents, agent("c", { parentId: "a" })] });
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerUp", viewport, 100, 340);
    expect(edge("a")).toHaveClass("sel");
    expect(edge("c")).toHaveClass("sel");
    expect(edge("b")).not.toHaveClass("sel");
  });

  it("brings a delegated agent in as the design does: its link draws, then its window opens", () => {
    vi.useFakeTimers();
    const { rerender } = mount(canvasOf());
    rerender({ agents: [...agents, agent("c", { parentId: "a" })], canvas: withC });
    expect(card("c")).toHaveClass("boot-edge");
    expect(edge("c")).toHaveClass("in");
    expect(document.querySelector('.sala-edge-head[data-edge="c"]')).not.toBeNull();
    expect(card("a")).toHaveClass("delegating");
    act(() => void vi.advanceTimersByTime(420));
    expect(card("c")).toHaveClass("boot-frame");
    expect(card("c")).not.toHaveClass("boot-edge");
    act(() => void vi.advanceTimersByTime(700));
    expect(card("c").className).not.toMatch(/boot-/);
    expect(edge("c")).not.toHaveClass("in");
    expect(document.querySelector('.sala-edge-head[data-edge="c"]')).toBeNull();
    expect(card("a")).not.toHaveClass("delegating");
  });

  it("opens an agent whose parent is not on the canvas at once, and leaves the ones it opened with alone", () => {
    vi.useFakeTimers();
    const { rerender } = mount(canvasOf());
    expect(document.querySelector('[class*="boot-"]')).toBeNull();
    rerender({ agents: [...agents, agent("c", { parentId: "elsewhere" })], canvas: withC });
    expect(card("c")).toHaveClass("boot-frame");
    act(() => void vi.advanceTimersByTime(700));
    expect(card("c")).not.toHaveClass("boot-frame");
  });

  // A card that comes back (Undo after a removal) or arrives over the relay
  // must be in the DOM with its arrival classes from its first render: added
  // after mount, it was painted in place for a frame, hidden, then opened.
  it.each([0, 2000])("puts a returning card and its link in with their arrival classes from the first render (undone after %ims)", (after) => {
    vi.useFakeTimers();
    const withC = [...agents, agent("c", { parentId: "a" })];
    const { rerender } = mount(canvasOf({ positions: { ...canvasOf().positions, c: { x: 24, y: 552 } } }), { agents: withC });
    const positions = { ...canvasOf().positions, c: { x: 24, y: 552 } };
    rerender({ agents, canvas: canvasOf({ positions }) });
    expect(document.querySelector('[data-agent-id="c"]')).toBeNull();
    act(() => void vi.advanceTimersByTime(after));
    const seen = new MutationObserver(() => undefined);
    seen.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    rerender({ agents: withC, canvas: canvasOf({ positions }) });
    const changes = seen.takeRecords().filter((r) => (r.target as Element).closest('[data-agent-id="c"], [data-edge="c"]'));
    seen.disconnect();
    // Nothing was put in plain and switched to arriving afterwards.
    expect(changes.map((r) => `${(r.target as Element).getAttribute("class") ?? ""} <- ${r.oldValue ?? ""}`)).toEqual([]);
    expect(card("c")).toHaveClass("boot-edge");
    expect(edge("c")).toHaveClass("in");
    act(() => void vi.advanceTimersByTime(420));
    expect(card("c")).toHaveClass("boot-frame");
    act(() => void vi.advanceTimersByTime(700));
    expect(card("c").className).not.toMatch(/boot-/);
  });

  it("fades a new area in", () => {
    vi.useFakeTimers();
    const { rerender } = mount(canvasOf());
    rerender({ canvas: canvasOf({ areas: [{ id: "x", label: "", x: 0, y: 0, members: ["a"] }] }) });
    expect(document.querySelector('[data-area-id="x"]')).toHaveClass("born");
    act(() => void vi.advanceTimersByTime(400));
    expect(document.querySelector('[data-area-id="x"]')).not.toHaveClass("born");
  });

  it("eases a dropped card onto the grid: saved at once, settled within 180ms", () => {
    vi.useFakeTimers();
    const { onCanvasChange, viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerMove", viewport, 150, 360);
    pointer("pointerMove", viewport, 197, 393);
    expect(document.querySelector(".sala-world")).not.toHaveClass("moving");
    expect(viewport).toHaveAttribute("data-dragging");
    pointer("pointerUp", viewport, 197, 393);
    expect(onCanvasChange).toHaveBeenCalledTimes(1);
    expect(card("a").style.transform).toBe("translate(120px, 336px)");
    // Dropped at (121, 341): it starts there and eases the last pixels.
    expect(card("a").style.translate).toBe("1px 5px");
    act(() => void vi.advanceTimersByTime(200));
    expect(card("a").style.translate).toBe("");
    expect(viewport).not.toHaveAttribute("data-dragging");
  });

  it("fades the toolbar out when its card is deselected before taking it away", () => {
    vi.useFakeTimers();
    const { viewport } = mount(canvasOf());
    pointer("pointerDown", card("a").querySelector(".sala-node-body")!, 100, 340);
    pointer("pointerUp", viewport, 100, 340);
    expect(bar()).not.toHaveClass("out");
    pointer("pointerDown", viewport, 900, 700);
    pointer("pointerUp", viewport, 900, 700);
    expect(card("a")).not.toHaveClass("sel");
    expect(bar()).toHaveClass("out");
    expect(bar()).toHaveAttribute("inert");
    act(() => void vi.advanceTimersByTime(120));
    expect(bar()).toBeNull();
  });
});

describe("SalaCanvas — the orchestrator's card", () => {
  it("opens its conversation on a click, without selecting it or showing a bar", () => {
    const onOpenAgent = vi.fn();
    const { viewport } = mount(canvasOf(), { onOpenAgent });
    pointer("pointerDown", card("main").querySelector(".sala-node-body")!, 300, 80);
    pointer("pointerUp", viewport, 300, 80);
    expect(onOpenAgent).toHaveBeenCalledWith("main");
    expect(card("main")).not.toHaveClass("sel");
    expect(document.querySelector(".sala-bar")).toBeNull();
  });

  it("opens it from the keyboard too (Enter on the card activates its button)", () => {
    const onOpenAgent = vi.fn();
    mount(canvasOf(), { onOpenAgent });
    fireEvent.click(card("main").querySelector(".sala-node-hit")!, { detail: 0 });
    expect(onOpenAgent).toHaveBeenCalledWith("main");
    expect(document.querySelector(".sala-bar")).toBeNull();
  });

  it("still selects a worker and shows its bar", () => {
    const onOpenAgent = vi.fn();
    mount(canvasOf(), { onOpenAgent });
    fireEvent.click(card("a").querySelector(".sala-node-hit")!);
    expect(onOpenAgent).not.toHaveBeenCalled();
    expect(card("a")).toHaveClass("sel");
    expect(screen.getByRole("toolbar", { name: "Agent actions" })).toBeInTheDocument();
  });
});

describe("SalaCanvas — removing agents asks first", () => {
  const worktree = (agentId: string, branch: string): RoomWorktree => ({ id: `wt-${branch}`, agentId, repoRoot: "/r", path: `/r/${branch}`, branch, state: "ready", phase: "idle", integrated: false });
  const pressBar = (label: string): void => {
    fireEvent.click(card("a").querySelector(".sala-node-hit")!);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Agent actions" })).getByRole("button", { name: label }));
  };

  it("asks before removing, and removes only once the person says so, with a way back", async () => {
    const onRemoveAgent = vi.fn(() => Promise.resolve({ undoMs: 5000 }));
    mount(canvasOf(), { onRemoveAgent });
    pressBar("Remove");
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove “a” from the room?");
    expect(dialog).toHaveTextContent("The agent stops and leaves the room. What they already wrote stays in the context.");
    expect(onRemoveAgent).not.toHaveBeenCalled();
    const remove = within(dialog).getByRole("button", { name: "Remove" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(onRemoveAgent).toHaveBeenCalledWith("a", false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByText("Agent removed from the room")).toBeInTheDocument();
  });

  it("removes nothing when the question is cancelled, by its button or by Esc", async () => {
    const onRemoveAgent = vi.fn(() => Promise.resolve({ undoMs: 5000 }));
    mount(canvasOf(), { onRemoveAgent });
    pressBar("Remove");
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    pressBar("Remove");
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onRemoveAgent).not.toHaveBeenCalled();
  });

  it("answers yes on Enter, wherever the focus is in the dialog", async () => {
    const onRemoveAgent = vi.fn(() => Promise.resolve({ undoMs: 5000 }));
    mount(canvasOf(), { onRemoveAgent });
    pressBar("Remove");
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Remove" })).toBeEnabled());
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Enter" });
    expect(onRemoveAgent).toHaveBeenCalledWith("a", false);
  });

  it("says which agents leave along: the ones it delegated to", async () => {
    const room = [...agents, agent("a1", { parentId: "a" }), agent("a2", { parentId: "a" })];
    mount(canvasOf({ positions: { ...canvasOf().positions, a1: { x: 24, y: 600 }, a2: { x: 360, y: 600 } } }), { agents: room });
    pressBar("Remove");
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("The agent stops and leaves the room, along with the 2 agents it delegated to.");
  });

  it("asks about work nobody integrated in the same question, never in a second one", async () => {
    const onRemoveAgent = vi.fn(() => Promise.resolve({ undoMs: 5000 }));
    const onCheckWork = vi.fn(() => Promise.resolve([worktree("a", "anywh/spike")]));
    mount(canvasOf(), { onRemoveAgent, onCheckWork });
    pressBar("Remove");
    const dialog = await screen.findByRole("alertdialog");
    expect(onCheckWork).toHaveBeenCalledWith(["a"]);
    const discard = await within(dialog).findByRole("button", { name: "Discard and remove" });
    expect(dialog).toHaveTextContent("Their work that was not integrated is discarded too:");
    expect(dialog).toHaveTextContent("anywh/spike");
    fireEvent.click(discard);
    expect(onRemoveAgent).toHaveBeenCalledTimes(1);
    expect(onRemoveAgent).toHaveBeenCalledWith("a", true);
    await screen.findByRole("button", { name: "Undo" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks again, with the work, when the relay finds some the check did not", async () => {
    const onRemoveAgent = vi.fn((_: string, discard: boolean) => Promise.resolve(discard ? { undoMs: 5000 } : { needsDiscard: [worktree("a", "anywh/late")] }));
    mount(canvasOf(), { onRemoveAgent });
    pressBar("Remove");
    const first = await screen.findByRole("alertdialog");
    await waitFor(() => expect(within(first).getByRole("button", { name: "Remove" })).toBeEnabled());
    fireEvent.click(within(first).getByRole("button", { name: "Remove" }));
    const again = await screen.findByRole("button", { name: "Discard and remove" });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("anywh/late");
    fireEvent.click(again);
    expect(onRemoveAgent).toHaveBeenLastCalledWith("a", true);
  });

  it("leaves the room alone while the dialog is pressed or typed in: no pan, no shortcut, no Esc for the room", async () => {
    const onEscape = vi.fn();
    const onNewAgent = vi.fn();
    const { viewport } = mount(canvasOf(), { onEscape, onNewAgent });
    pressBar("Remove");
    const cancel = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" });
    pointer("pointerDown", cancel, 10, 10);
    pointer("pointerMove", viewport, 60, 60);
    expect(viewport).not.toHaveAttribute("data-panning");
    pointer("pointerUp", viewport, 60, 60);
    fireEvent.keyDown(cancel, { key: "a" });
    expect(onNewAgent).not.toHaveBeenCalled();
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("stops an agent without asking", () => {
    const onStopAgent = vi.fn(() => Promise.resolve(true));
    mount(canvasOf(), { onStopAgent });
    pressBar("Stop");
    expect(onStopAgent).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("SalaCanvas — selecting several agents", () => {
  const room = [...agents, agent("c", { state: "done" })];
  const positions = { ...canvasOf().positions, c: { x: 600, y: 288 } };
  const mountRoom = (props: Partial<SalaCanvasProps> = {}, over: Partial<RoomCanvas> = {}) => mount(canvasOf({ positions, ...over }), { agents: room, ...props });
  const hit = (id: string): HTMLElement => card(id).querySelector<HTMLElement>(".sala-node-hit")!;
  const multiBar = (): HTMLElement => screen.getByRole("toolbar", { name: "Actions for the selected agents" });
  const selectedIds = (): string[] => [...document.querySelectorAll(".sala-node.sel")].map((el) => el.getAttribute("data-agent-id")!);

  it("adds and takes cards with Shift+click, and shows the bar for all of them instead of one card's", () => {
    const onSelectMany = vi.fn();
    mountRoom({ onSelectMany });
    fireEvent.click(hit("a"));
    fireEvent.click(hit("b"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a", "b"]);
    expect(multiBar()).toHaveTextContent("2 agents");
    expect(multiBar()).toHaveTextContent("Shift or Ctrl + click to change");
    // The single card's bar is on its way out (it fades), never shown with the other.
    expect(document.querySelector(".sala-bar:not(.out)")).toBeNull();
    expect(onSelectMany).toHaveBeenCalled();
    fireEvent.click(hit("c"), { shiftKey: true });
    expect(multiBar()).toHaveTextContent("3 agents");
    // Back down to one: a plain selection again, with its own bar.
    fireEvent.click(hit("c"), { shiftKey: true });
    fireEvent.click(hit("b"), { shiftKey: true });
    expect(selectedIds()).toEqual(["a"]);
    expect(screen.queryByRole("toolbar", { name: "Actions for the selected agents" })).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Agent actions" })).toBeInTheDocument();
  });

  it("takes Ctrl+click off macOS, where Command is not the selection's key", () => {
    mountRoom();
    fireEvent.click(hit("a"), { ctrlKey: true });
    fireEvent.click(hit("b"), { ctrlKey: true });
    expect(selectedIds()).toEqual(["a", "b"]);
    fireEvent.click(hit("c"), { metaKey: true });
    expect(selectedIds()).toEqual(["c"]);
  });

  it("never takes the orchestrator in: a modified click on it opens its conversation", () => {
    const onOpenAgent = vi.fn();
    mountRoom({ onOpenAgent });
    fireEvent.click(hit("a"), { shiftKey: true });
    fireEvent.click(hit("main"), { shiftKey: true });
    expect(onOpenAgent).toHaveBeenCalledWith("main");
    expect(selectedIds()).toEqual([]);
  });

  it("counts one press once, though the pointer and the card's button both report it", () => {
    const { viewport } = mountRoom();
    fireEvent.click(hit("a"));
    fireEvent.pointerDown(card("b").querySelector(".sala-node-body")!, { clientX: 400, clientY: 340, pointerId: 1, button: 0, shiftKey: true });
    fireEvent.pointerUp(viewport, { clientX: 400, clientY: 340, pointerId: 1, button: 0, shiftKey: true });
    fireEvent.click(hit("b"), { shiftKey: true, detail: 1 });
    expect(selectedIds()).toEqual(["a", "b"]);
  });

  it("clears with Esc, with a click on the room and with the bar's ×", () => {
    const { viewport } = mountRoom();
    const pickTwo = (): void => {
      fireEvent.click(hit("a"), { shiftKey: true });
      fireEvent.click(hit("b"), { shiftKey: true });
      expect(selectedIds()).toEqual(["a", "b"]);
    };
    pickTwo();
    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(selectedIds()).toEqual([]);
    pickTwo();
    pointer("pointerDown", viewport, 1000, 700);
    pointer("pointerUp", viewport, 1000, 700);
    expect(selectedIds()).toEqual([]);
    pickTwo();
    fireEvent.click(within(multiBar()).getByRole("button", { name: "Clear the selection" }));
    expect(selectedIds()).toEqual([]);
  });

  it("groups the selection in a new area at once when none of it is in an area", () => {
    const { onCanvasChange } = mountRoom();
    fireEvent.click(hit("a"), { shiftKey: true });
    fireEvent.click(hit("b"), { shiftKey: true });
    fireEvent.click(within(multiBar()).getByRole("button", { name: "Group" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.areas).toHaveLength(1);
    expect(saved.areas[0].members).toEqual(["a", "b"]);
    expect(screen.getByText("Area created · 2 agents grouped")).toBeInTheDocument();
    expect(selectedIds()).toEqual([]);
  });

  it("asks before grouping agents out of the areas they are in, naming them", async () => {
    const { onCanvasChange } = mountRoom({}, { areas: [{ id: "x", label: "Design", x: 0, y: 0, members: ["a"] }, { id: "y", label: "", x: 0, y: 0, members: ["c"] }] });
    fireEvent.click(hit("a"), { shiftKey: true });
    fireEvent.click(hit("b"), { shiftKey: true });
    fireEvent.click(hit("c"), { shiftKey: true });
    fireEvent.click(within(multiBar()).getByRole("button", { name: "Group" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Create a new area?");
    expect(dialog).toHaveTextContent("3 agents go to a new area and leave the areas they are in now:");
    expect(within(dialog).getByText("Design")).toBeInTheDocument();
    expect(within(dialog).getByText("Unnamed area")).toBeInTheDocument();
    expect(onCanvasChange).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create area" }));
    const saved = onCanvasChange.mock.calls[0][0] as RoomCanvas;
    expect(saved.areas[saved.areas.length - 1].members).toEqual(["a", "b", "c"]);
    expect(saved.areas.slice(0, 2).map((a) => a.members)).toEqual([[], []]);
  });

  it("stops the ones that can stop, without asking", async () => {
    const onStopAgent = vi.fn(() => Promise.resolve(true));
    mountRoom({ onStopAgent });
    fireEvent.click(hit("a"), { shiftKey: true });
    fireEvent.click(hit("c"), { shiftKey: true });
    expect(within(multiBar()).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    fireEvent.click(within(multiBar()).getByRole("button", { name: "Stop" }));
    expect(onStopAgent).toHaveBeenCalledTimes(1);
    expect(onStopAgent).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText("Agent stopped")).toBeInTheDocument();
  });

  it("offers no Stop when none of them can stop", () => {
    mountRoom({ agents: [...room, agent("d", { state: "stopped" })] }, { positions: { ...positions, d: { x: 900, y: 288 } } });
    fireEvent.click(hit("c"), { shiftKey: true });
    fireEvent.click(hit("d"), { shiftKey: true });
    expect(within(multiBar()).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("removes them all after one question, from the bar or with Delete", async () => {
    const onRemoveAgent = vi.fn(() => Promise.resolve({ undoMs: 5000 }));
    const { viewport } = mountRoom({ onRemoveAgent });
    fireEvent.click(hit("a"), { shiftKey: true });
    fireEvent.click(hit("b"), { shiftKey: true });
    fireEvent.keyDown(viewport, { key: "Delete" });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove 2 agents from the room?");
    expect(dialog).toHaveTextContent("The agents stop and leave the room. What they already wrote stays in the context.");
    const remove = within(dialog).getByRole("button", { name: "Remove" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(onRemoveAgent.mock.calls).toEqual([
      ["a", false],
      ["b", false],
    ]);
    expect(await screen.findByText("2 agents left the room")).toBeInTheDocument();
    expect(selectedIds()).toEqual([]);
  });
});
