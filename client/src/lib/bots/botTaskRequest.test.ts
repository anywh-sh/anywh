import { describe, expect, it, vi } from "vitest";
import { askPanelTask, onPanelTask, takePanelTask } from "./botTaskRequest";

describe("bot task requests", () => {
  it("a request is taken once, per room, and the room's listeners are told", () => {
    const told = vi.fn();
    const other = vi.fn();
    const off = onPanelTask("room-a", told);
    onPanelTask("room-b", other);
    askPanelTask("room-a", 4);
    expect(told).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(takePanelTask("room-b")).toBeUndefined();
    expect(takePanelTask("room-a")).toBe(4);
    expect(takePanelTask("room-a")).toBeUndefined();
    off();
    askPanelTask("room-a", 5);
    expect(told).toHaveBeenCalledTimes(1);
    expect(takePanelTask("room-a")).toBe(5);
  });

  it("a later request replaces one not yet taken", () => {
    askPanelTask("room-c", 1);
    askPanelTask("room-c", 2);
    expect(takePanelTask("room-c")).toBe(2);
  });
});
