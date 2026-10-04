import { beforeEach, describe, expect, it } from "vitest";
import { getLastEffort, setLastEffort } from "./useEffortPreference";

beforeEach(() => localStorage.clear());

describe("last-used effort", () => {
  it("is null until one was recorded", () => {
    expect(getLastEffort("p1", "claude")).toBeNull();
  });

  it("is scoped per profile and per agent — a level only means something to the agent that listed it", () => {
    setLastEffort("p1", "claude", "high");
    setLastEffort("p1", "codex", "ultra");
    setLastEffort("p2", "claude", "low");
    expect(getLastEffort("p1", "claude")).toBe("high");
    expect(getLastEffort("p1", "codex")).toBe("ultra");
    expect(getLastEffort("p2", "claude")).toBe("low");
  });

  it("survives corrupt storage by reading as empty", () => {
    localStorage.setItem("anywh:last-effort", "{not json");
    expect(getLastEffort("p1", "claude")).toBeNull();
    setLastEffort("p1", "claude", "max");
    expect(getLastEffort("p1", "claude")).toBe("max");
  });
});
