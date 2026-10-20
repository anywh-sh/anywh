import { describe, expect, it } from "vitest";
import type { RoomAgent, RoomMemberInfo, RoomWorktree } from "@/lib/relay/roomClient";
import { agentWork, formatBytes, formatTokens, retainedWorktrees, roomCounts, usageRows } from "@/lib/sala/roomFigures";

const usage = (input: number, create: number, read: number) => ({ responses: 1, inputTokens: input, cacheCreationInputTokens: create, cacheReadInputTokens: read, cacheHitRate: null });
const member = (id: string, u: ReturnType<typeof usage>): RoomMemberInfo => ({ id, title: id, agentId: "claude", model: null, usage: u });

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

describe("usageRows", () => {
  it("sorts by tokens, drops idle agents and shares the room's total", () => {
    const { rows, total } = usageRows([member("a", usage(100, 0, 100)), member("b", usage(0, 0, 0)), member("c", usage(300, 100, 200))]);
    expect(total).toBe(800);
    expect(rows.map((r) => [r.agentId, r.tokens, r.share])).toEqual([
      ["c", 600, 75],
      ["a", 200, 25],
    ]);
  });
  it("is empty before anything ran", () => {
    expect(usageRows([member("a", usage(0, 0, 0))])).toEqual({ rows: [], total: 0 });
  });
});

describe("roomCounts", () => {
  const agent = (agentId: string, over: Partial<RoomAgent>): RoomAgent => ({ agentId, role: "worker", parentId: "m", title: agentId, runtime: "claude", model: null, createdBy: "agent", state: "working", queuedMessages: 0, needsYou: [], subtasksRunning: 0, connectors: [], ...over });
  it("counts by what each card says", () => {
    const counts = roomCounts([
      agent("m", { role: "principal", parentId: undefined, state: "waiting" }),
      agent("a", {}),
      agent("b", { state: "done" }),
      agent("c", { state: "failed" }),
      agent("d", { state: "awaiting_user", needsYou: [{ kind: "choice", promptId: "p", count: 1 }] }),
    ]);
    expect(counts).toEqual({ agents: 5, running: 2, waiting: 1, done: 1, failed: 1 });
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
