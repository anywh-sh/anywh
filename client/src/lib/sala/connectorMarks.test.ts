import { describe, expect, it } from "vitest";
import { connectorLabel, connectorMark } from "@/lib/sala/connectorMarks";

describe("connectorMark", () => {
  it("matches by substring of the name the person gave the server", () => {
    expect(connectorMark("figma")?.key).toBe("figma");
    expect(connectorMark("claude_ai_Figma")?.key).toBe("figma");
    expect(connectorMark("my-Linear-workspace")?.key).toBe("linear");
    expect(connectorMark("jira-cloud")?.key).toBe("atlassian");
  });
  it("has no mark for a server it does not know", () => {
    expect(connectorMark("internal-tools")).toBeUndefined();
  });
});

describe("connectorLabel", () => {
  it("prints separators as spaces", () => {
    expect(connectorLabel("claude_ai_Figma")).toBe("claude ai Figma");
    expect(connectorLabel("figma")).toBe("figma");
  });
});
