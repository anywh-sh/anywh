import { describe, expect, it } from "vitest";
import { resolveDefaultAgent } from "./useAgentPreference";

const both = ["claude", "codex"];

describe("resolveDefaultAgent", () => {
  it("uses the fixed agent when it is selectable", () => {
    expect(resolveDefaultAgent({ mode: "fixed", fixedAgentId: "codex" }, "claude", both)).toBe("codex");
  });

  it("ignores a fixed agent that is no longer selectable and falls to last used", () => {
    expect(resolveDefaultAgent({ mode: "fixed", fixedAgentId: "codex" }, "claude", ["claude"])).toBe("claude");
  });

  it("follows the last used agent in lastUsed mode and when no preference is set", () => {
    expect(resolveDefaultAgent({ mode: "lastUsed" }, "codex", both)).toBe("codex");
    expect(resolveDefaultAgent(undefined, "codex", both)).toBe("codex");
  });

  it("falls to the first selectable agent without a usable last used", () => {
    expect(resolveDefaultAgent(undefined, undefined, ["codex", "claude"])).toBe("codex");
    expect(resolveDefaultAgent(undefined, "gemini", both)).toBe("claude");
  });

  it("falls to the relay default with nothing selectable", () => {
    expect(resolveDefaultAgent({ mode: "fixed", fixedAgentId: "codex" }, undefined, [])).toBe("claude");
  });
});
