import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DockEmptyState } from "@/components/shell/DockEmptyState";

describe("DockEmptyState", () => {
  it("asks the user to pick an option", () => {
    render(<DockEmptyState />);
    expect(screen.getByTestId("dock-empty-state")).toHaveTextContent("Select an option to visualize");
  });
});
