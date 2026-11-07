import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRefreshControl, type RefreshControlInput } from "@/components/shell/RefreshControl";

const labels = { refresh: "Refresh", againIn: "again in {duration}" };

function input(patch: Partial<RefreshControlInput>): RefreshControlInput {
  return { reading: false, cooldownMs: null, age: "4m ago", onRefresh: () => {}, labels, ...patch };
}

describe("useRefreshControl", () => {
  it("refreshes once per click burst while nothing holds it", () => {
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useRefreshControl(input({ onRefresh })));
    expect(result.current.held).toBe(false);
    expect(result.current.title).toBe("Refresh");
    act(() => {
      result.current.handleRefresh();
      result.current.handleRefresh();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("holds while reading or within the relay's floor, and says when it frees up", () => {
    const onRefresh = vi.fn();
    const reading = renderHook(() => useRefreshControl(input({ onRefresh, reading: true })));
    expect(reading.result.current.held).toBe(true);
    const floor = renderHook(() => useRefreshControl(input({ onRefresh, cooldownMs: 12_000 })));
    expect(floor.result.current.held).toBe(true);
    expect(floor.result.current.title).toBe("4m ago · again in 12s");
    act(() => floor.result.current.handleRefresh());
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
