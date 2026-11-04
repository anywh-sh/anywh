import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDock } from "@/components/shell/SessionDock";
import type { DockState } from "@/hooks/tabs/useSessionDock";

afterEach(cleanup);

function renderDock(dock: Partial<DockState> = {}) {
  const onWidthChange = vi.fn();
  const onDragEnd = vi.fn();
  const state: DockState = { panes: ["terminal"], width: 480, maximized: null, ...dock };
  render(
    <SessionDock dock={state} onWidthChange={onWidthChange} onDragEnd={onDragEnd} panes={{ terminal: <div>term</div>, agent: <div>agent</div> }} />,
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
