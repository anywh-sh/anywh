import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "anywh:sala-side-width";

function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

// The width is a module-level store shared by every panel, so each test loads
// a fresh copy of the module to start from what `localStorage` holds.
async function renderPanel() {
  vi.resetModules();
  const { SalaSidePanel } = await import("./SalaSidePanel");
  render(
    <SalaSidePanel mark={null} title="Room" subtitle="About" kind="about" onClose={() => {}}>
      <p>body</p>
    </SalaSidePanel>,
  );
  return screen.getByRole("separator");
}

const drawnWidth = (): string => document.documentElement.style.getPropertyValue("--sala-side-w");

describe("SalaSidePanel resizing", () => {
  beforeEach(() => {
    localStorage.clear();
    // Wide enough that the conversation's text column (729px) is the limit.
    setWindowWidth(1600);
  });
  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--sala-side-w");
  });

  it("starts at the default width, which is also the minimum", async () => {
    const grip = await renderPanel();
    expect(grip).toHaveAttribute("aria-valuenow", "385");
    expect(grip).toHaveAttribute("aria-valuemin", "385");
    expect(grip).toHaveAttribute("aria-valuemax", "729");
    expect(drawnWidth()).toBe("385px");
  });

  it("widens when the left edge is dragged left, and keeps the width once let go", async () => {
    const grip = await renderPanel();
    fireEvent.pointerDown(grip, { clientX: 1000 });
    fireEvent.pointerMove(window, { clientX: 900 });
    expect(grip).toHaveAttribute("aria-valuenow", "485");
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(KEY)).toBe("485");
    expect(drawnWidth()).toBe("485px");
  });

  it("does not shrink below the default nor grow past the maximum", async () => {
    const grip = await renderPanel();
    fireEvent.pointerDown(grip, { clientX: 1000 });
    fireEvent.pointerMove(window, { clientX: 1200 });
    expect(grip).toHaveAttribute("aria-valuenow", "385");
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(grip).toHaveAttribute("aria-valuenow", "729");
    fireEvent.pointerUp(window);
  });

  it("moves with the arrow keys and jumps to the limits with Home and End", async () => {
    const grip = await renderPanel();
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    expect(grip).toHaveAttribute("aria-valuenow", "401");
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(grip).toHaveAttribute("aria-valuenow", "385");
    fireEvent.keyDown(grip, { key: "End" });
    expect(grip).toHaveAttribute("aria-valuenow", "729");
    expect(localStorage.getItem(KEY)).toBe("729");
    fireEvent.keyDown(grip, { key: "Home" });
    expect(grip).toHaveAttribute("aria-valuenow", "385");
  });

  it("goes back to the default on a double click", async () => {
    localStorage.setItem(KEY, "600");
    const grip = await renderPanel();
    expect(grip).toHaveAttribute("aria-valuenow", "600");
    fireEvent.doubleClick(grip);
    expect(grip).toHaveAttribute("aria-valuenow", "385");
    expect(localStorage.getItem(KEY)).toBe("385");
  });

  it("clamps a stored width that is out of range or not a number", async () => {
    localStorage.setItem(KEY, "9000");
    expect(await renderPanel()).toHaveAttribute("aria-valuenow", "729");
  });

  it("narrows with the window and returns to the chosen width when it grows back", async () => {
    localStorage.setItem(KEY, "600");
    const grip = await renderPanel();
    setWindowWidth(1000);
    expect(grip).toHaveAttribute("aria-valuenow", "500");
    expect(grip).toHaveAttribute("aria-valuemax", "500");
    expect(drawnWidth()).toBe("500px");
    // Wide enough that the conversation's text column (729px) is the limit.
    setWindowWidth(1600);
    expect(grip).toHaveAttribute("aria-valuenow", "600");
  });
});
