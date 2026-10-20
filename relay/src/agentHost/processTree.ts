// Finding and ending every process that belongs to an agent.
//
// Each agent's `claude` is spawned as the leader of its own process group and
// session (`setsid`), so the group can be signalled as a unit. That is not
// enough on its own: Claude Code's Bash tool runs each command in a process
// group (and session) of its own, so `kill -- -<pgid>` never reaches a
// `sleep`/build/dev server a tool started. Measured on Claude Code 2.1.303:
//   - SIGTERM to `claude` makes it clean up its tools' processes itself;
//   - SIGKILL to its group leaves those processes running, re-parented to
//     the user's systemd (or init).
// So stopping is SIGTERM to the process and its group, a grace period, then
// SIGKILL to the group — and then a sweep for anything of that agent still
// alive, found by an environment marker every agent process inherits
// (`ANYWH_AGENT_HOST_ID`/`ANYWH_AGENT_ID`). The sweep reads
// /proc/<pid>/environ, so it is Linux-only; elsewhere only the group is
// covered. A process that rewrites its own environment (`env -i ...`) also
// escapes the sweep — a known limit, as is anything that detaches on purpose
// and clears its environment; containing those would need a cgroup per agent.
import { readFile, readdir } from "node:fs/promises";

export const HOST_ID_ENV = "ANYWH_AGENT_HOST_ID";
export const AGENT_ID_ENV = "ANYWH_AGENT_ID";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals a pid (positive) or a process group (negative). Never throws for
 * a target that is already gone. */
export function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/** This process and its ancestors: never targets of a sweep, whatever
 * environment they were started with. */
async function selfAndAncestors(): Promise<Set<number>> {
  const pids = new Set<number>([process.pid]);
  let pid = process.ppid;
  for (let depth = 0; depth < 64 && pid > 1 && !pids.has(pid); depth++) {
    pids.add(pid);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 4 (ppid) follows the parenthesized command name, which may
      // itself contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      pid = Number(fields[1]);
    } catch {
      break;
    }
  }
  return pids;
}

/** Live processes carrying this host's marker, optionally only one agent's.
 * Empty on platforms without /proc. */
export async function findAgentProcesses(hostId: string, agentId?: string): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const hostMarker = `${HOST_ID_ENV}=${hostId}`;
  const agentMarker = agentId === undefined ? undefined : `${AGENT_ID_ENV}=${agentId}`;
  const excluded = await selfAndAncestors();
  const found: number[] = [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = Number(entry);
      if (excluded.has(pid)) return;
      let environ: string;
      try {
        environ = await readFile(`/proc/${pid}/environ`, "utf8");
      } catch {
        return; // gone, or not ours to read
      }
      const vars = environ.split("\0");
      if (!vars.includes(hostMarker)) return;
      if (agentMarker !== undefined && !vars.includes(agentMarker)) return;
      found.push(pid);
    }),
  );
  return found.sort((a, b) => a - b);
}

/** Waits until none of `pids` is alive, or `timeoutMs` passes. */
export async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pids.some(isAlive)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Ends every process carrying the marker: SIGTERM, a short grace, SIGKILL.
 * Returns how many were found. */
export async function sweepAgentProcesses(hostId: string, agentId: string | undefined, graceMs: number): Promise<number> {
  const pids = await findAgentProcesses(hostId, agentId);
  if (pids.length === 0) return 0;
  for (const pid of pids) signal(pid, "SIGTERM");
  if (!(await waitForExit(pids, graceMs))) {
    for (const pid of pids) signal(pid, "SIGKILL");
    await waitForExit(pids, 2000);
  }
  return pids.length;
}

/** Proportional set size of the given processes, in bytes (Linux; 0
 * elsewhere). Shared pages are split among the processes sharing them, so
 * sums across agents do not double count. */
export async function pssBytes(pids: readonly number[]): Promise<number> {
  if (process.platform !== "linux") return 0;
  let total = 0;
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
        const match = /^Pss:\s+(\d+) kB/m.exec(rollup);
        if (match) total += Number(match[1]) * 1024;
      } catch {
        // gone
      }
    }),
  );
  return total;
}
