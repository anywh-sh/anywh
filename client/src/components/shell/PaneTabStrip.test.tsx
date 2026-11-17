import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PaneTabStrip } from "./PaneTabStrip";
import { en } from "@/i18n/en";

afterEach(() => cleanup());

const tabs = [
  { id: "t1", label: "Terminal 1" },
  { id: "t2", label: "Terminal 2" },
];

function renderStrip(activeId: string | null, handlers: { onSelect?: (id: string) => void; onClose?: (id: string) => void } = {}) {
  return render(
    <TooltipProvider>
      <PaneTabStrip tabs={tabs} activeId={activeId} onSelect={handlers.onSelect ?? vi.fn()} onClose={handlers.onClose ?? vi.fn()} onAdd={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("PaneTabStrip", () => {
  it("is a tablist with only the active tab in the Tab order", () => {
    renderStrip("t2");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0"]);
  });

  it("keeps the first tab reachable when none is active", () => {
    renderStrip(null);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1"]);
  });

  it("selects with the arrow keys", async () => {
    const onSelect = vi.fn();
    renderStrip("t1", { onSelect });
    screen.getByRole("tab", { name: "Terminal 1" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenCalledWith("t2");
  });

  it("closes from the ×, which sits beside the tab and does not select it", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderStrip("t1", { onSelect, onClose });
    const close = screen.getByRole("button", { name: en.panels.closeTab.replace("{name}", "Terminal 2") });
    expect(screen.getByRole("tab", { name: "Terminal 2" })).not.toContainElement(close);
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledWith("t2");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
