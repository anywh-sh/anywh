import { describe, expect, it } from "vitest";
import { groupByState } from "@/lib/format/sessionStateGroups";
import type { MergedSession } from "@/lib/format/sessionGrouping";
import type { RoomStatus } from "@/lib/sala/roomStatus";

const session = (id: string, room = false): MergedSession => ({ id, title: id, lastActiveAt: 0, profileId: "p", ...(room ? { room: true as const } : {}) });
const status = (over: Partial<RoomStatus>): RoomStatus => ({ agents: 3, working: 0, needsYou: 0, failed: 0, completed: false, ...over });

describe("groupByState", () => {
  it("puts a room that waits for the person first, then what runs, then the rest", () => {
    const groups = groupByState(
      [session("chat"), session("busy"), session("room-a", true), session("room-b", true), session("room-c", true)],
      new Set(["busy"]),
      new Map([
        ["room-a", status({ needsYou: 2, working: 1 })],
        ["room-b", status({ working: 2 })],
        ["room-c", status({ failed: 1 })],
      ]),
    );
    expect(groups.needsYou.map((s) => s.id)).toEqual(["room-a"]);
    expect(groups.running.map((s) => s.id)).toEqual(["busy", "room-b"]);
    expect(groups.rest.map((s) => s.id)).toEqual(["chat", "room-c"]);
  });
  it("leaves a room with no known status in the rest", () => {
    expect(groupByState([session("room-a", true)], new Set(), new Map()).rest).toHaveLength(1);
  });
});
