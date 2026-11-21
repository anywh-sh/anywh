import { describe, expect, it } from "vitest";
import { MASCOT_GRID, mascotBitmap, mascotCells, mascotParts, mascotStateOf, rerollSeed } from "@/lib/bots/mascot";

describe("mascot", () => {
  it("the same seed always gives the same figure, whatever its case or spacing", () => {
    expect(mascotParts("Vigia")).toEqual(mascotParts(" vigia "));
    expect(mascotBitmap(mascotParts("Vigia"), "idle")).toBe(mascotBitmap(mascotParts("Vigia"), "idle"));
  });

  it("names spread over different figures", () => {
    const names = ["Vigia", "Revisor", "Standup", "Faxina", "Docs", "Triagem", "Mabel", "Otto", "Lumi", "Brisa", "Cora", "Pixel"];
    const figures = new Set(names.map((name) => mascotBitmap(mascotParts(name), "idle")));
    expect(figures.size).toBeGreaterThanOrEqual(9);
    expect(mascotParts(rerollSeed("Vigia", 1))).not.toEqual(mascotParts(rerollSeed("Vigia", 0)));
  });

  it("stays inside the grid and keeps the body in every state", () => {
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const parts = mascotParts(name);
      for (const state of ["idle", "working", "needsYou", "paused", "failed"] as const) {
        const cells = mascotCells(parts, state);
        expect(cells.every((cell) => cell.x >= 0 && cell.x < MASCOT_GRID && cell.y >= 0 && cell.y < MASCOT_GRID)).toBe(true);
        expect(cells.some((cell) => cell.face)).toBe(true);
        expect(new Set(cells.map((cell) => `${String(cell.x)},${String(cell.y)}`)).size).toBe(cells.length);
      }
      expect(mascotCells(parts, "setup").some((cell) => cell.face)).toBe(false);
    }
  });

  it("the state changes the face, not who it is", () => {
    const parts = mascotParts("Vigia");
    expect(mascotBitmap(parts, "needsYou")).not.toBe(mascotBitmap(parts, "idle"));
    expect(mascotBitmap(parts, "needsYou").replace(/o/g, "#")).toBe(mascotBitmap(parts, "idle").replace(/o/g, "#"));
    expect(mascotBitmap(parts, "idle")).toHaveLength(MASCOT_GRID * MASCOT_GRID);
  });

  it("what needs the person wins over everything but a pause", () => {
    const base = { paused: false, firstRun: false, needsYou: 0, working: 0, busy: false, lastRunFailed: false };
    expect(mascotStateOf({ ...base, needsYou: 1, working: 2 })).toBe("needsYou");
    expect(mascotStateOf({ ...base, paused: true, needsYou: 1 })).toBe("paused");
    expect(mascotStateOf({ ...base, busy: true })).toBe("working");
    expect(mascotStateOf({ ...base, firstRun: true })).toBe("setup");
    expect(mascotStateOf({ ...base, lastRunFailed: true })).toBe("failed");
    expect(mascotStateOf(base)).toBe("idle");
  });
});
