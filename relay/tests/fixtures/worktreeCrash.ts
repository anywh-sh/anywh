// Runs one worktree operation in a process that exits abruptly at a chosen
// point between two of its steps, as a crash would. Used by
// roomWorktrees.io.test.ts; argument: a JSON object.
import { WorktreeRegistry } from "../../src/host/worktreeRegistry.js";
import { RoomWorktrees } from "../../src/session/roomWorktrees.js";

const { registryFile, root, repo, point, action } = JSON.parse(process.argv[2] ?? "{}") as { registryFile: string; root: string; repo: string; point: string; action: "create" | "cleanup" };

const worktrees = new RoomWorktrees({
  registry: new WorktreeRegistry(registryFile),
  root,
  agents: { facts: () => ({ exists: true, busy: false, done: true, title: "Crasher", cwd: repo, roomId: "room" }) },
  gh: "/nonexistent/gh",
  crashPoint: (reached) => {
    if (reached === point) process.exit(77);
  },
});

if (action === "create") await worktrees.create("room", "agent-1", repo);
else await worktrees.cleanupAgent("agent-1", { auto: true });
console.log("finished without reaching the crash point");
