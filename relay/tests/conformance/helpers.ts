// What every conformance test shares: the opt-in gate, a throwaway home, and
// an environment that keeps the real CLIs off the network apart from the
// local fake servers. Never the person's own profile: every CLI here runs
// with `HOME` pointed at a fresh temporary folder.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentBin } from "../../src/runtimes/executables.js";

export const CONFORMANCE_ENV = "ANYWH_CONFORMANCE";

/** `false` (run) when opted in, else why the test is skipped. */
export const conformanceSkip: string | false =
  process.env[CONFORMANCE_ENV] === "1" ? false : `runs the real agent CLIs; set ${CONFORMANCE_ENV}=1 (npm run test:conformance)`;

// Inherited by every CLI the relay's code spawns below (buildChildEnv
// starts from this process's environment): no update check, no telemetry,
// no background traffic of the CLI's own.
for (const [name, value] of Object.entries({ DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })) process.env[name] = value;
// A config home set in the environment would win over the throwaway HOME.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

/** A fresh folder to be the CLI's `$HOME`, and its removal — twice, since a
 * CLI that was just told to close may still write a cache file on its way
 * out. */
export function throwawayHome(prefix: string): { home: string; cleanup: () => Promise<void> } {
  const home = mkdtempSync(join(tmpdir(), `anywh-conformance-${prefix}-`));
  return {
    home,
    cleanup: async () => {
      rmSync(home, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The installed CLI's version line, for the test's diagnostics. */
export function installedVersion(bin: string): string {
  try {
    return execFileSync(resolveAgentBin(bin), ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "not installed";
  }
}
