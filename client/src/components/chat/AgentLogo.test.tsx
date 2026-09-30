import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentLogo, agentVendor } from "@/components/chat/AgentLogo";

describe("AgentLogo", () => {
  it("renders a distinct mark per known agent and a fallback for unknown ids", () => {
    const claude = render(<AgentLogo agentId="claude" />).container.innerHTML;
    const codex = render(<AgentLogo agentId="codex" />).container.innerHTML;
    const other = render(<AgentLogo agentId="gemini" />).container.innerHTML;
    expect(new Set([claude, codex, other]).size).toBe(3);
  });

  it("names the vendor only for known agents", () => {
    expect(agentVendor("claude")).toBe("Anthropic");
    expect(agentVendor("codex")).toBe("OpenAI");
    expect(agentVendor("gemini")).toBeUndefined();
  });
});
