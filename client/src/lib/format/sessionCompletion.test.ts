import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompletedSessions,
  getCompletedSessions,
  markSessionCompleted,
  markSessionsSeen,
  resetCompletedSessionsForTest,
  roomIsBusy,
  roomJustCompleted,
  withCompletion,
  withoutCompletion,
} from "@/lib/format/sessionCompletion";
import type { RoomStatus } from "@/lib/sala/roomStatus";

const status = (over: Partial<RoomStatus>): RoomStatus => ({ agents: 3, working: 0, needsYou: 0, failed: 0, completed: false, ...over });

describe("completion map", () => {
  it("adds, refreshes and drops entries without mutating the input", () => {
    const empty = new Map<string, number>();
    const one = withCompletion(empty, "a", 1);
    expect(empty.size).toBe(0);
    expect(withCompletion(one, "a", 1)).toBe(one);
    expect([...withCompletion(one, "a", 5)]).toEqual([["a", 5]]);
    expect(withoutCompletion(one, ["zzz"])).toBe(one);
    expect(withoutCompletion(one, ["a"]).size).toBe(0);
  });
  it("keeps the newest entries when it grows past its bound", () => {
    let map: ReadonlyMap<string, number> = new Map();
    for (let i = 0; i < 250; i++) map = withCompletion(map, `s${String(i)}`, i);
    expect(map.size).toBe(200);
    expect(map.has("s0")).toBe(false);
    expect(map.has("s249")).toBe(true);
  });
});

describe("store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompletedSessionsForTest();
  });
  it("persists completions, forgets them when seen and clears all at once", () => {
    markSessionCompleted("a", 10);
    markSessionCompleted("b", 20);
    expect(JSON.parse(localStorage.getItem("anywh:completed-sessions") ?? "[]")).toEqual([["a", 10], ["b", 20]]);
    markSessionsSeen(["a"]);
    expect([...getCompletedSessions().keys()]).toEqual(["b"]);
    clearCompletedSessions();
    expect(getCompletedSessions().size).toBe(0);
  });
});

describe("room transitions", () => {
  it("counts only a completion seen happening", () => {
    expect(roomJustCompleted(undefined, status({ completed: true }))).toBe(false);
    expect(roomJustCompleted(status({ completed: true }), status({ completed: true }))).toBe(false);
    expect(roomJustCompleted(status({ working: 2 }), status({ completed: true }))).toBe(true);
  });
  it("does not count a room that still needs the person or failed", () => {
    expect(roomJustCompleted(status({ working: 1 }), status({ completed: true, failed: 1 }))).toBe(false);
    expect(roomJustCompleted(status({ working: 1 }), status({ completed: true, needsYou: 1 }))).toBe(false);
  });
  it("reports a busy room", () => {
    expect(roomIsBusy(status({ working: 1 }))).toBe(true);
    expect(roomIsBusy(status({}))).toBe(false);
  });
});

