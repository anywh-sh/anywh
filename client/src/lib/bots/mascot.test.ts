import { describe, expect, it } from "vitest";
import { MASCOT_CHARACTERS, MASCOT_GRID, MASCOT_ORDER, MASCOT_PAUSED_TONE, MASCOT_TONE_ORDER, MASCOT_TONES, mascotChoiceOf, mascotLayers, mascotPixels, mascotStateOf, mixColor, type MascotState } from "@/lib/bots/mascot";

const STATES: MascotState[] = ["idle", "working", "needsYou", "paused", "setup", "failed", "limit"];

describe("mascot", () => {
  it("every character is a 16×16 drawing, and no two look alike", () => {
    expect(MASCOT_ORDER).toHaveLength(10);
    for (const id of MASCOT_ORDER) {
      expect(MASCOT_CHARACTERS[id].map).toHaveLength(MASCOT_GRID);
      for (const row of MASCOT_CHARACTERS[id].map) expect(row).toHaveLength(MASCOT_GRID);
    }
    const figures = new Set(MASCOT_ORDER.map((id) => mascotPixels({ character: id, tone: "giz" }).pixels));
    expect(figures.size).toBe(MASCOT_ORDER.length);
  });

  it("stays inside the grid in every state, and setting up draws no body", () => {
    for (const id of MASCOT_ORDER) {
      for (const state of STATES) {
        for (const layer of mascotLayers({ character: id, tone: MASCOT_CHARACTERS[id].tone }, state)) {
          for (const [x, y, w, h] of layer.rects) {
            expect(x >= 0 && y >= 0 && x + w <= MASCOT_GRID && y + h <= MASCOT_GRID).toBe(true);
          }
        }
      }
      expect(mascotLayers({ character: id, tone: "giz" }, "setup").map((layer) => layer.layer)).not.toContain("B");
    }
  });

  it("the tone colors the body and its light and shade; the state changes the face, not the silhouette", () => {
    const sand = mascotLayers({ character: "bip", tone: "areia" });
    expect(sand.find((layer) => layer.layer === "B")?.color).toBe(MASCOT_TONES.areia);
    expect(sand.find((layer) => layer.layer === "Bl")?.color).toBe(mixColor(MASCOT_TONES.areia, "#ffffff", 0.32));
    const idle = mascotPixels({ character: "bip", tone: "areia" }, "idle").pixels;
    const asking = mascotPixels({ character: "bip", tone: "areia" }, "needsYou").pixels;
    expect(asking).not.toBe(idle);
    expect(asking.replace(/[^.]/g, "#")).toBe(idle.replace(/[^.]/g, "#"));
  });

  it("a paused bot is grey whatever its tone", () => {
    for (const tone of MASCOT_TONE_ORDER) expect(mascotLayers({ character: "chip", tone }, "paused").find((layer) => layer.layer === "B")?.color).toBe(MASCOT_PAUSED_TONE);
  });

  it("the drawer's pixels name only colors of their palette", () => {
    const { pixels, palette } = mascotPixels({ character: "tela", tone: "ardosia" }, "working");
    expect(pixels).toHaveLength(MASCOT_GRID * MASCOT_GRID);
    for (const letter of new Set(pixels.replace(/\./g, ""))) expect(letter.charCodeAt(0) - 97).toBeLessThan(palette.length);
  });

  it("reads whatever the relay sent as a mascot, falling back to Bip in its tone", () => {
    expect(mascotChoiceOf({ character: "tela", tone: "rosa" })).toEqual({ character: "tela", tone: "rosa" });
    expect(mascotChoiceOf({ character: "tela" })).toEqual({ character: "tela", tone: "ardosia" });
    expect(mascotChoiceOf({ seed: "Vigia" })).toEqual({ character: "bip", tone: "areia" });
    expect(mascotChoiceOf(undefined)).toEqual({ character: "bip", tone: "areia" });
  });

  it("derives the face from the bot's summary, what needs the person first", () => {
    const base = { paused: false, firstRun: false, needsYou: 0, working: 0, busy: false, lastRunFailed: false };
    expect(mascotStateOf({ ...base, needsYou: 1, working: 2 })).toBe("needsYou");
    expect(mascotStateOf({ ...base, paused: true, needsYou: 1 })).toBe("paused");
    expect(mascotStateOf({ ...base, busy: true })).toBe("working");
    expect(mascotStateOf({ ...base, firstRun: true })).toBe("setup");
    expect(mascotStateOf({ ...base, lastRunFailed: true })).toBe("failed");
    expect(mascotStateOf({ ...base, lastRunFailed: true, limitedUntil: 2000 }, 1000)).toBe("limit");
    expect(mascotStateOf({ ...base, limitedUntil: 500 }, 1000)).toBe("idle");
    expect(mascotStateOf(base)).toBe("idle");
  });
});
