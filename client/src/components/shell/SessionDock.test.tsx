import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDock } from "@/components/shell/SessionDock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelTogglesSlot } from "@/hooks/usePanelTogglesSlot";
import { getPanelTogglesSlot } from "@/lib/panelTogglesSlot";
import type { DockState } from "@/hooks/tabs/useSessionDock";

afterEach(cleanup);

function renderDock(dock: Partial<DockState> = {}) {
  const onWidthChange = vi.fn();
  const onDragEnd = vi.fn();
  const state: DockState = { panes: ["terminal"], width: 480, maximized: null, ...dock };
  render(
    <TooltipProvider>
      <SessionDock dock={state} onWidthChange={onWidthChange} onDragEnd={onDragEnd} groupId="g1" panes={{ terminal: <div>term</div>, agent: <div>agent</div> }} />
    </TooltipProvider>,
  );
  return { onWidthChange, onDragEnd, separator: screen.getByRole("separator", { name: "Resize panel" }) };
}

describe("SessionDock edge", () => {
  it("is a focusable separator that reports the width and its limits", () => {
    const { separator } = renderDock();
    expect(separator).toHaveAttribute("aria-valuenow", "480");
    expect(separator).toHaveAttribute("aria-valuemin", "320");
    expect(separator).toHaveAttribute("aria-valuemax", "900");
    expect(separator).toHaveAttribute("tabindex", "0");
  });

  it("uses the room pane minimum when a room pane is in the column", () => {
    const { separator } = renderDock({ panes: ["agent"] });
    expect(separator).toHaveAttribute("aria-valuemin", "385");
  });

  it("widens on ArrowLeft and narrows on ArrowRight, saving each step", () => {
    const { separator, onWidthChange, onDragEnd } = renderDock();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenLastCalledWith(496);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenLastCalledWith(464);
    expect(onDragEnd).toHaveBeenCalledTimes(2);
  });

  it("jumps to the limits with Home and End", () => {
    const { separator, onWidthChange } = renderDock();
    fireEvent.keyDown(separator, { key: "Home" });
    expect(onWidthChange).toHaveBeenLastCalledWith(320);
    fireEvent.keyDown(separator, { key: "End" });
    expect(onWidthChange).toHaveBeenLastCalledWith(900);
  });

  it("ignores other keys", () => {
    const { separator, onWidthChange } = renderDock();
    fireEvent.keyDown(separator, { key: "a" });
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("restores the default width on a double click", () => {
    const { separator, onWidthChange, onDragEnd } = renderDock({ width: 700 });
    fireEvent.doubleClick(separator);
    expect(onWidthChange).toHaveBeenCalledWith(480);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });
});

/** Stands in for a tab's `ChatPanel`: portals a button into its group's slot. */
function PortaledButton({ groupId }: { groupId: string }) {
  const slot = usePanelTogglesSlot(groupId);
  return slot ? createPortal(<button type="button">pane button</button>, slot) : null;
}

function renderRail(dock: Partial<DockState>, extra: { background?: boolean } = {}) {
  const state: DockState = { panes: [], width: 480, maximized: null, ...dock };
  const result = render(
    <TooltipProvider>
      <SessionDock dock={state} onWidthChange={vi.fn()} onDragEnd={vi.fn()} groupId="g1" background={extra.background} panes={{ terminal: <div>term</div> }} />
      <PortaledButton groupId="g1" />
    </TooltipProvider>,
  );
  return { ...result, rail: () => screen.getByTestId("dock-rail") };
}

describe("SessionDock rail", () => {
  it("stays with the panel closed, with the panes' buttons in it", () => {
    const { rail } = renderRail({ panes: [] });
    expect(within(rail()).getByRole("button", { name: "pane button" })).toBeInTheDocument();
    expect(screen.queryByText("term")).not.toBeInTheDocument();
  });

  it("publishes its group's slot while mounted and releases it on unmount", () => {
    const { unmount } = renderRail({});
    expect(getPanelTogglesSlot("g1")).not.toBeNull();
    unmount();
    expect(getPanelTogglesSlot("g1")).toBeNull();
  });

  // A room's dock stays mounted in the background; the group's slot belongs
  // to the tab on screen.
  it("claims no slot for a tab in the background", () => {
    renderRail({}, { background: true });
    expect(getPanelTogglesSlot("g1")).toBeNull();
    expect(screen.queryByText("pane button")).not.toBeInTheDocument();
  });
});
