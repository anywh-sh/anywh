import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useStoredFolds } from "./GroupHeading";

beforeEach(() => localStorage.clear());

describe("useStoredFolds", () => {
  it("keeps the folds across an unmount, per key", () => {
    const first = renderHook(({ storageKey }) => useStoredFolds(storageKey), { initialProps: { storageKey: "folds:p1:jira" } });
    act(() => first.result.current[1]("To Do"));
    expect([...first.result.current[0]]).toEqual(["To Do"]);
    first.unmount();

    const again = renderHook(({ storageKey }) => useStoredFolds(storageKey), { initialProps: { storageKey: "folds:p1:jira" } });
    expect([...again.result.current[0]]).toEqual(["To Do"]);

    // Another profile or integration reads its own folds.
    again.rerender({ storageKey: "folds:p2:jira" });
    expect([...again.result.current[0]]).toEqual([]);
    act(() => again.result.current[1]("Done"));
    expect([...again.result.current[0]]).toEqual(["Done"]);
    again.rerender({ storageKey: "folds:p1:jira" });
    expect([...again.result.current[0]]).toEqual(["To Do"]);
  });

  it("unfolds a group pressed twice", () => {
    const { result } = renderHook(() => useStoredFolds("folds:p1:jira"));
    act(() => result.current[1]("To Do"));
    act(() => result.current[1]("To Do"));
    expect([...result.current[0]]).toEqual([]);
    expect(localStorage.getItem("folds:p1:jira")).toBe("[]");
  });
});
