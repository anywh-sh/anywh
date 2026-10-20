// Linux only: the sweep reads /proc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAlive, sweepAgentProcesses } from "./processTree.js";

const linux = process.platform === "linux";

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function hasMark(pid: number, mark: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`ANYWH_AGENT_MARK=${mark}`);
  } catch {
    return false;
  }
}

function childPid(parent: number): number | undefined {
  try {
    return Number(readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/)[0]) || undefined;
  } catch {
    return undefined;
  }
}

test("a swept process whose parent never reaps it (a zombie) counts as gone at once", { skip: !linux }, async () => {
  const hostId = `zombie-${process.pid}`;
  // The marked `sleep` is the child of an unmarked `sleep` that never waits
  // for it, so once it dies it stays a zombie.
  const parent: ChildProcess = spawn("sh", ["-c", `ANYWH_AGENT_MARK=${hostId}:a1:n sleep 300 & exec sleep 301`], { stdio: "ignore" });
  try {
    let child: number | undefined;
    await waitFor(() => (child = childPid(parent.pid!)) !== undefined && hasMark(child, `${hostId}:a1:n`));
    const started = Date.now();
    assert.equal(await sweepAgentProcesses(hostId, "a1", 5000), 1);
    assert.ok(Date.now() - started < 2000, `sweep waited ${Date.now() - started}ms on a zombie`);
  } finally {
    parent.kill("SIGKILL");
  }
});

test("a process that no longer carries the mark when the grace period ends is not killed", { skip: !linux }, async () => {
  const hostId = `recycle-${process.pid}`;
  // On SIGTERM it replaces itself (same pid) with a program without the
  // mark — what a recycled pid looks like to the sweep.
  const proc = spawn("sh", ["-c", "trap 'exec env -u ANYWH_AGENT_MARK sleep 300' TERM; while :; do sleep 0.05; done"], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, ANYWH_AGENT_MARK: `${hostId}:a1:n` },
  });
  try {
    await waitFor(() => hasMark(proc.pid!, `${hostId}:a1:n`));
    await sweepAgentProcesses(hostId, "a1", 500);
    assert.equal(isAlive(proc.pid!), true, "the pid was SIGKILLed after it stopped being the agent's");
  } finally {
    proc.kill("SIGKILL");
  }
});
