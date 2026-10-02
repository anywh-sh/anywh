import { describe, expect, it, vi } from "vitest";
import { createBubbleMenu } from "./bubbleMenu";

const rect = { x: 1, y: 2, width: 3, height: 4 };
const items = [{ id: "copy", label: "Copy" }];

function setup() {
  const send = vi.fn();
  return { send, menu: createBubbleMenu({ send }) };
}

describe("createBubbleMenu", () => {
  it("sends the rect and items when a bubble arms", () => {
    const { menu, send } = setup();
    menu.arm({ id: "a", rect, items, onSelect: vi.fn() });
    expect(send).toHaveBeenCalledExactlyOnceWith({ id: "a", rect, items });
  });

  it("routes a pick to the armed bubble", () => {
    const { menu } = setup();
    const onSelect = vi.fn();
    menu.arm({ id: "a", rect, items, onSelect });
    menu.dispatch({ targetId: "a", itemId: "copy" });
    expect(onSelect).toHaveBeenCalledWith("copy");
  });

  it("ignores a pick for a bubble that is no longer armed", () => {
    const { menu } = setup();
    const first = vi.fn();
    const second = vi.fn();
    menu.arm({ id: "a", rect, items, onSelect: first });
    menu.arm({ id: "b", rect, items, onSelect: second });
    menu.dispatch({ targetId: "a", itemId: "copy" });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("disarms with a null rect, and only when something is armed", () => {
    const { menu, send } = setup();
    menu.disarm();
    expect(send).not.toHaveBeenCalled();
    menu.arm({ id: "a", rect, items, onSelect: vi.fn() });
    menu.disarm();
    expect(send).toHaveBeenLastCalledWith({ id: "a", rect: null, items: [] });
    menu.disarm();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
