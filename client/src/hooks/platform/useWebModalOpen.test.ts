import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWebModalOpen } from "./useWebModalOpen";

afterEach(() => {
  document.body.innerHTML = "";
});

function addDialog(role: string, state: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  el.setAttribute("data-state", state);
  document.body.appendChild(el);
  return el;
}

const flush = () => act(async () => void (await Promise.resolve()));

describe("useWebModalOpen", () => {
  it("is false with no dialog", () => {
    expect(renderHook(() => useWebModalOpen()).result.current).toBe(false);
  });

  it("follows a dialog opening and closing", async () => {
    const { result } = renderHook(() => useWebModalOpen());
    let dialog!: HTMLElement;
    await act(async () => {
      dialog = addDialog("dialog", "open");
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
    await act(async () => {
      dialog.setAttribute("data-state", "closed");
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
    await act(async () => {
      dialog.remove();
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it("counts an alert dialog too", async () => {
    const { result } = renderHook(() => useWebModalOpen());
    addDialog("alertdialog", "open");
    await flush();
    expect(result.current).toBe(true);
  });

  it("ignores a closed one and non-modal roles", async () => {
    const { result } = renderHook(() => useWebModalOpen());
    await act(async () => {
      addDialog("dialog", "closed");
      addDialog("menu", "open");
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });
});
