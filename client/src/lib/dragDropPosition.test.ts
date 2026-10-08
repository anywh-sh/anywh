import { describe, expect, it } from "vitest";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { physicalPositionToClientPoint } from "@/lib/dragDropPosition";

const position = { x: 1200, y: 600 } as PhysicalPosition;

describe("physicalPositionToClientPoint", () => {
  it("divides by the pixel ratio on Windows, where Tauri reports physical pixels", () => {
    expect(physicalPositionToClientPoint(position, "windows", 2)).toEqual({ x: 600, y: 300 });
  });

  it.each(["macos", "linux"])("passes the position through on %s, where it is already logical", (platform) => {
    expect(physicalPositionToClientPoint(position, platform, 2)).toEqual({ x: 1200, y: 600 });
  });

  it("passes it through when the platform is unknown", () => {
    expect(physicalPositionToClientPoint(position, null, 2)).toEqual({ x: 1200, y: 600 });
  });
});
