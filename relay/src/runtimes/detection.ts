import { spawn } from "node:child_process";
import { buildChildEnv } from "../host/childEnv.js";
import { resolveAgentBin } from "./executables.js";
import type { AgentRuntimeDef, Capabilities } from "./types.js";

const DETECTION_TIMEOUT_MS = 3000;

export interface AgentDetection {
  readonly id: string;
  readonly installed: boolean;
  /** `stdout.trim()` of `--version`, whatever shape that takes for this
   * particular CLI — this file doesn't parse it, only proves the binary
   * runs. `undefined` when not installed or when the probe timed out. */
  readonly version?: string;
  /** Pass-through of the def's own declared capabilities, never inferred
   * from the binary — a def states what it supports, detection only says
   * whether that def's binary is actually present and runs. */
  readonly capabilities: Capabilities;
}

/**
 * Runs `<bin> --version` for one def and reports whether it's installed —
 * never rejects, so a broken or missing binary can't take the rest of a
 * `detectRuntimes` call down with it. Every failure mode (spawn error,
 * non-zero exit, timeout) resolves to `installed: false` instead of
 * throwing.
 */
export function detectRuntime(def: AgentRuntimeDef, homeOverride?: string): Promise<AgentDetection> {
  return new Promise((resolve) => {
    const bin = resolveAgentBin(def.identity.bin);
    const stripCredentials = (env: NodeJS.ProcessEnv): void => {
      for (const name of def.identity.env.strip) delete env[name];
    };
    const notInstalled = (): AgentDetection => ({ id: def.identity.id, installed: false, capabilities: def.capabilities });

    let child;
    try {
      child = spawn(bin, ["--version"], { env: buildChildEnv(homeOverride, [], stripCredentials, def.identity.env.set) });
    } catch {
      resolve(notInstalled());
      return;
    }

    let settled = false;
    const finish = (result: AgentDetection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(notInstalled());
    }, DETECTION_TIMEOUT_MS);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // ENOENT (binary not found) and similar spawn failures land here,
    // asynchronously, on POSIX — the synchronous try/catch above only
    // catches the rarer case of a bad spawn option.
    child.on("error", () => finish(notInstalled()));
    child.on("close", (code) => {
      finish(code === 0 ? { id: def.identity.id, installed: true, version: stdout.trim(), capabilities: def.capabilities } : notInstalled());
    });
  });
}

/** No `Promise.allSettled` needed — `detectRuntime` itself never rejects,
 * so one broken def can't fail the batch. */
export function detectRuntimes(defs: readonly AgentRuntimeDef[], homeOverride?: string): Promise<readonly AgentDetection[]> {
  return Promise.all(defs.map((def) => detectRuntime(def, homeOverride)));
}
