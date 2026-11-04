import { describe, expect, it } from "vitest";
import type { RoomAgent, RoomSubtaskView } from "@/lib/relay/roomClient";
import { edgePath } from "@/lib/sala/layout";
import { MINI_GAP, MINI_H, MINI_MAX, MINI_W, SUB_DROP, footprint, subtaskBand, subtaskRects, subtaskTone, visibleSubtasks } from "@/lib/sala/subtasks";

function sub(taskId: string, startedAt: number, over: Partial<RoomSubtaskView> = {}): RoomSubtaskView {
  return { taskId, toolUseId: `tu-${taskId}`, status: "running", startedAt, ...over };
}
function worker(over: Partial<RoomAgent> = {}): RoomAgent {
  return { agentId: "w", role: "worker", parentId: "main", title: "w", runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], startedAt: 100, ...over };
}
const ids = (agent: RoomAgent): string[] => visibleSubtasks(agent).shown.map((s) => s.taskId);

describe("visibleSubtasks", () => {
  it("shows the present run's subtasks oldest first, a finished one keeping its place", () => {
    const agent = worker({ subtasks: [sub("b", 120), sub("a", 110, { status: "completed", endedAt: 130 }), sub("c", 140)] });
    expect(ids(agent)).toEqual(["a", "b", "c"]);
    const later = worker({ subtasks: [sub("a", 110, { status: "completed" }), sub("b", 120, { status: "stopped" }), sub("c", 140)] });
    expect(ids(later)).toEqual(["a", "b", "c"]);
  });

  it("leaves out what an earlier run finished, but never one still running", () => {
    const agent = worker({ startedAt: 100, subtasks: [sub("old", 50, { status: "completed" }), sub("lingering", 60), sub("now", 120)] });
    expect(ids(agent)).toEqual(["lingering", "now"]);
  });

  it("shows none once the agent is over and nothing runs; the panel keeps them", () => {
    const finished = [sub("a", 110, { status: "completed" }), sub("b", 120, { status: "failed" })];
    for (const state of ["done", "failed", "blocked", "stopped"] as const) expect(ids(worker({ state, subtasks: finished }))).toEqual([]);
    expect(ids(worker({ state: "awaiting_user", subtasks: finished }))).toEqual(["a", "b"]);
    expect(ids(worker({ state: "done", subtasks: [...finished, sub("c", 130)] }))).toEqual(["a", "b", "c"]);
  });

  it("shows none for an agent with no subtasks, or a relay that sends none", () => {
    expect(visibleSubtasks(worker())).toEqual({ shown: [], hidden: 0 });
    expect(visibleSubtasks(worker({ subtasks: [] }))).toEqual({ shown: [], hidden: 0 });
  });

  it("past the cap, keeps every running one and the latest finished, and counts the rest for a +N card", () => {
    const subtasks = [
      ...Array.from({ length: 5 }, (_, i) => sub(`f${String(i)}`, 101 + i, { status: "completed" })),
      sub("r1", 110),
      sub("r2", 111),
    ];
    const { shown, hidden } = visibleSubtasks(worker({ subtasks }));
    expect(shown.map((s) => s.taskId)).toEqual(["f2", "f3", "f4", "r1", "r2"]);
    expect(hidden).toBe(2);
    expect(shown.length + 1).toBe(MINI_MAX);
  });
});

describe("the subtask band", () => {
  const parent = { x: 240, y: 96, w: 312, h: 145 };

  it("sits centred under the parent, SUB_DROP below its card", () => {
    const band = subtaskBand(parent, 3)!;
    expect(band.x + band.w / 2).toBe(parent.x + parent.w / 2);
    expect(band.y).toBe(parent.y + parent.h + SUB_DROP);
    expect(band.w).toBe(3 * MINI_W + 2 * MINI_GAP);
    expect(band.h).toBe(MINI_H);
    expect(subtaskBand(parent, 0)).toBeUndefined();
  });

  it("fills rows of three from the left, the next row below", () => {
    const rects = subtaskRects(parent, 5);
    const band = subtaskBand(parent, 5)!;
    expect(rects.map((r) => r.x)).toEqual([band.x, band.x + MINI_W + MINI_GAP, band.x + 2 * (MINI_W + MINI_GAP), band.x, band.x + MINI_W + MINI_GAP]);
    expect(rects[3].y).toBe(band.y + MINI_H + MINI_GAP);
    expect(band.h).toBe(2 * MINI_H + MINI_GAP);
  });

  it("links each mini-card with the canvas' own straight elbow, never a diagonal", () => {
    for (const rect of subtaskRects(parent, 6)) {
      const d = edgePath(parent, rect);
      expect(d).toMatch(/^M[\d.-]+ [\d.-]+(?:[VH][\d.-]+)+$/);
    }
    // Close rows: the run across sits halfway down the drop.
    expect(edgePath(parent, subtaskRects(parent, 1)[0])).toContain(`V${String(parent.y + parent.h + SUB_DROP / 2)}H`);
  });

  it("takes the card and its band together as its footprint", () => {
    const band = subtaskBand(parent, 3)!;
    expect(footprint(parent, band)).toEqual({ x: band.x, y: parent.y, w: band.w, h: band.y + band.h - parent.y });
    expect(footprint(parent, undefined)).toBe(parent);
  });

  it("draws each link in its subtask's state", () => {
    expect([subtaskTone(sub("a", 1)), subtaskTone(sub("a", 1, { needsYou: true })), subtaskTone(sub("a", 1, { status: "completed" })), subtaskTone(sub("a", 1, { status: "failed" }))]).toEqual(["run", "wait", "done", "stop"]);
  });
});
