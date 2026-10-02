import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_NATIVE_BOTTOM_INSET, useNativeBottomInset } from "./useNativeBottomInset";

afterEach(() => document.documentElement.style.removeProperty("--native-bottom-inset"));

describe("useNativeBottomInset", () => {
  it("falls back until the native side reports", () => {
    const { result } = renderHook(() => useNativeBottomInset());
    expect(result.current).toBe(FALLBACK_NATIVE_BOTTOM_INSET);
  });

  it("reads the variable already set, and follows changes", async () => {
    document.documentElement.style.setProperty("--native-bottom-inset", "120.5px");
    const { result } = renderHook(() => useNativeBottomInset());
    expect(result.current).toBe(120.5);
    await act(async () => {
      document.documentElement.style.setProperty("--native-bottom-inset", "340px");
      await Promise.resolve();
    });
    expect(result.current).toBe(340);
  });
});
