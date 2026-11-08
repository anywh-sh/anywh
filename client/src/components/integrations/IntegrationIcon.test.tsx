import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationIcon } from "./IntegrationIcon";

const mark = (container: HTMLElement) => container.querySelector("svg")!;

describe("IntegrationIcon", () => {
  it("draws the Jira mark in its brand blue, over a caller's text color", () => {
    const { container } = render(<IntegrationIcon provider="jira" className="text-primary" />);
    expect(mark(container).getAttribute("fill")).toBe("#0052CC");
  });

  it("lets a caller opt the Jira mark out of its brand color", () => {
    const { container } = render(<IntegrationIcon provider="jira" monochrome />);
    expect(mark(container).getAttribute("fill")).toBe("currentColor");
  });

  it("keeps a mark without a brand color monochrome", () => {
    const { container } = render(<IntegrationIcon provider="linear" />);
    expect(mark(container).getAttribute("fill")).toBe("currentColor");
  });
});
