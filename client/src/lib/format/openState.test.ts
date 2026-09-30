import { describe, expect, it, vi } from "vitest";
import { OpenState } from "@/lib/format/openState";

describe("OpenState", () => {
  it("toggles a row and remembers it without any component mounted", () => {
    const state = new OpenState();
    state.toggle("a");
    expect(state.isOpen("a")).toBe(true);
    expect(state.isOpen("b")).toBe(false);
    state.toggle("a");
    expect(state.isOpen("a")).toBe(false);
  });

  it("notifies only the row that changed", () => {
    const state = new OpenState();
    const a = vi.fn();
    const b = vi.fn();
    state.subscribe("a", a);
    state.subscribe("b", b);
    state.toggle("a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("stops notifying once unsubscribed, and a re-mounted row sees the kept state", () => {
    const state = new OpenState();
    const notify = vi.fn();
    const unsubscribe = state.subscribe("a", notify);
    unsubscribe();
    state.toggle("a");
    expect(notify).not.toHaveBeenCalled();
    expect(state.isOpen("a")).toBe(true);
  });
});
