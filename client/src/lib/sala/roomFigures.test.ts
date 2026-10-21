import { describe, expect, it } from "vitest";
import type { RoomAgent, RoomMemberInfo, RoomWorktree } from "@/lib/relay/roomClient";
import { agentWork, formatBytes, formatTokens, retainedWorktrees, roomCounts, usageRows, windowPercent } from "@/lib/sala/roomFigures";

const member = (id: string, contextUsage: RoomMemberInfo["contextUsage"]): RoomMemberInfo => ({ id, title: id, agentId: "claude", model: null, contextUsage });

describe("formatBytes", () => {
  it("scales and rounds", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(312 * 1024 * 1024)).toBe("312 MB");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(54_300)).toBe("54k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("windowPercent", () => {
  it("is a whole percent of the window, capped, and null while the window is unknown", () => {
    expect(windowPercent({ usedTokens: 135_000, contextWindowSize: 200_000 })).toBe(68);
    expect(windowPercent({ usedTokens: 250_000, contextWindowSize: 200_000 })).toBe(100);
    expect(windowPercent({ usedTokens: 135_000 })).toBeNull();
  });
});

describe("usageRows", () => {
  it("sorts by how full the window is, drops agents with nothing and puts unknown windows last", () => {
    const rows = usageRows([member("a", { usedTokens: 20_000, contextWindowSize: 200_000 }), member("b", null), member("c", { usedTokens: 90_000, contextWindowSize: 200_000 }), member("d", { usedTokens: 5_000 })]);
    expect(rows.map((r) => [r.agentId, r.tokens, r.percent])).toEqual([
      ["c", 90_000, 45],
      ["a", 20_000, 10],
      ["d", 5_000, null],
    ]);
  });
  it("is empty before anything ran", () => {
    expect(usageRows([member("a", null), member("b", { usedTokens: 0 })])).toEqual([]);
  });
});

describe("roomCounts", () => {
  const agent = (agentId: string, over: Partial<RoomAgent>): RoomAgent => ({ agentId, role: "worker", parentId: "m", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over });
  it("counts workers by what each card says, and leaves the principal out of agents, running and done", () => {
    const counts = roomCounts([
      agent("m", { role: "principal", parentId: undefined, state: "waiting" }),
      agent("a", {}),
      agent("b", { state: "done" }),
      agent("c", { state: "failed" }),
      agent("d", { state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "p", count: 1 }] }),
    ]);
    expect(counts).toEqual({ agents: 4, running: 1, waiting: 1, done: 1, failed: 1 });
  });
  it("still counts a principal that needs the person", () => {
    const counts = roomCounts([
      agent("m", { role: "principal", parentId: undefined, state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "p", count: 1 }] }),
      agent("a", { state: "done" }),
      agent("b", { state: "done" }),
    ]);
    expect(counts).toEqual({ agents: 2, running: 0, waiting: 1, done: 2, failed: 0 });
  });
});

describe("worktrees", () => {
  const wt = (over: Partial<RoomWorktree>): RoomWorktree => ({ id: "w", agentId: "a", repoRoot: "/r", path: "/p", branch: "anywh/x", state: "active", phase: "idle", integrated: false, ...over });
  it("picks an agent's own and the ones nobody integrated", () => {
    const list = [wt({ commitsAhead: 3, sizeBytes: 10 }), wt({ id: "x", agentId: "b", integrated: true }), wt({ id: "y", agentId: "a", integrated: true, retainedReason: "dirty" })];
    expect(agentWork(list, "a")).toHaveLength(2);
    expect(retainedWorktrees(list).map((w) => w.id)).toEqual(["w", "y"]);
  });
});
