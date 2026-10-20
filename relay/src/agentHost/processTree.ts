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
// (`ANYWH_AGENT_MARK=<host id>:<agent id>:<host incarnation>`). The marker is
// deliberately not one of the host's configuration variables: those can sit
// in an env file shared with the relay, and a sweep keyed on them would
// match the relay and everything it runs. A mark is only valid with a
// non-empty agent id, and the sweep never matches anything else. The sweep reads
// /proc/<pid>/environ, so it is Linux-only; elsewhere only the group is
// covered. A process that rewrites its own environment (`env -i ...`) also
// escapes the sweep — a known limit, as is anything that detaches on purpose
// and clears its environment; containing those would need a cgroup per agent.
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

export const AGENT_MARK_ENV = "ANYWH_AGENT_MARK";
/** After SIGKILL in a sweep, how long to wait for the processes to go. */
export const SWEEP_KILL_WAIT_MS = 2000;

/** The mark an agent's process tree carries. Neither id may contain ":"
 * (host ids are profile slugs, agent ids are validated). */
export function agentMark(hostId: string, agentId: string, incarnation: string): string {
  return `${hostId}:${agentId}:${incarnation}`;
}

/** `{hostId, agentId}` of a well-formed mark; `undefined` for anything else,
 * including a mark with an empty agent id. */
export function parseAgentMark(value: string): { hostId: string; agentId: string } | undefined {
  const parts = value.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return undefined;
  return { hostId: parts[0], agentId: parts[1] };
}

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

/** Live processes carrying this host's marker, by agent id. Empty on
 * platforms without /proc. */
export async function agentProcessMap(hostId: string): Promise<Map<string, number[]>> {
  const byAgent = new Map<string, number[]>();
  if (process.platform !== "linux") return byAgent;
  const prefix = `${AGENT_MARK_ENV}=`;
  const excluded = await selfAndAncestors();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return byAgent;
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
      const raw = environ.split("\0").find((entry) => entry.startsWith(prefix));
      const mark = raw === undefined ? undefined : parseAgentMark(raw.slice(prefix.length));
      if (!mark || mark.hostId !== hostId) return;
      const list = byAgent.get(mark.agentId) ?? [];
      list.push(pid);
      byAgent.set(mark.agentId, list);
    }),
  );
  for (const list of byAgent.values()) list.sort((a, b) => a - b);
  return byAgent;
}

/** Live processes carrying this host's marker, optionally only one agent's.
 * Empty on platforms without /proc. */
export async function findAgentProcesses(hostId: string, agentId?: string): Promise<number[]> {
  const byAgent = await agentProcessMap(hostId);
  if (agentId !== undefined) return byAgent.get(agentId) ?? [];
  return [...byAgent.values()].flat().sort((a, b) => a - b);
}

/** Gone for the sweep's purposes: no such process, not ours to signal, or a
 * zombie (dead, only waiting for a parent that may never reap it). */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform !== "linux") return false;
  const stat = readFileSyncSafe(`/proc/${pid}/stat`);
  return stat === undefined || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether `pid` still carries this host's mark (for `agentId`, or any agent
 * when omitted). Read again right before a SIGKILL: between finding a pid
 * and killing it, the pid may have exited and been reused. */
function stillMarked(pid: number, hostId: string, agentId: string | undefined): boolean {
  if (process.platform !== "linux") return true;
  const environ = readFileSyncSafe(`/proc/${pid}/environ`);
  if (environ === undefined) return false;
  const prefix = `${AGENT_MARK_ENV}=`;
  const raw = environ.split("\0").find((entry) => entry.startsWith(prefix));
  const mark = raw === undefined ? undefined : parseAgentMark(raw.slice(prefix.length));
  return mark !== undefined && mark.hostId === hostId && (agentId === undefined || mark.agentId === agentId);
}

/** Waits until every one of `pids` is gone (zombies count), or `timeoutMs`. */
export async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pids.every(isGone)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Ends every process carrying the mark: SIGTERM, a short grace, then
 * SIGKILL to those that still carry it. Returns how many were found. */
export async function sweepAgentProcesses(hostId: string, agentId: string | undefined, graceMs: number): Promise<number> {
  const pids = await findAgentProcesses(hostId, agentId);
  if (pids.length === 0) return 0;
  for (const pid of pids) signal(pid, "SIGTERM");
  if (!(await waitForExit(pids, graceMs))) {
    const remaining = pids.filter((pid) => !isGone(pid) && stillMarked(pid, hostId, agentId));
    for (const pid of remaining) signal(pid, "SIGKILL");
    await waitForExit(remaining, SWEEP_KILL_WAIT_MS);
  }
  return pids.length;
}

function parentOf(pid: number): number | undefined {
  const stat = readFileSyncSafe(`/proc/${pid}/stat`);
  if (stat === undefined) return undefined;
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Processes of the agent that are no longer under its CLI's process tree
 * (re-parented after their parent exited): jobs it detached on purpose,
 * like a dev server started to outlive the turn. Linux only. */
export async function detachedAgentProcesses(hostId: string, agentId: string, rootPid: number): Promise<number[]> {
  const pids = await findAgentProcesses(hostId, agentId);
  return pids.filter((pid) => {
    if (pid === rootPid) return false;
    let current: number | undefined = pid;
    for (let depth = 0; depth < 64 && current !== undefined && current > 1; depth++) {
      current = parentOf(current);
      if (current === rootPid) return false;
    }
    return true;
  });
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
