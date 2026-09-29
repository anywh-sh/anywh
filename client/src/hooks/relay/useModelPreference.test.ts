import { beforeEach, describe, expect, it } from "vitest";
import { getPreferredModel, setLastModel } from "./useModelPreference";

beforeEach(() => localStorage.clear());

describe("getPreferredModel (lastUsed mode)", () => {
  it("has nothing to preselect before any history, instead of guessing one agent's model", () => {
    expect(getPreferredModel("p1", "codex")).toBeNull();
    expect(getPreferredModel("p1", "claude")).toBeNull();
  });

  it("remembers the last model per agent, so switching agents doesn't cross them", () => {
    setLastModel("p1", "claude", "opus");
    setLastModel("p1", "codex", "gpt-5.5");

    expect(getPreferredModel("p1", "claude")).toBe("opus");
    expect(getPreferredModel("p1", "codex")).toBe("gpt-5.5");
  });

  it("still reads an entry recorded per profile only, from before models were per agent", () => {
    localStorage.setItem("anywh:last-model", JSON.stringify({ p1: "sonnet" }));

    expect(getPreferredModel("p1", "claude")).toBe("sonnet");
  });
});
