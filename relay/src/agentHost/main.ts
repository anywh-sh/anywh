// Entrypoint of the agent host service (`anywh-agent-host@<profile>`): one
// per profile, next to that profile's relay, built from the same package.
//
//   node dist/agentHost/main.js --profile <id> [--socket <path>] [--data-dir <dir>] [--host-id <id>]
//
// `--profile` is required and never read from the environment implicitly:
// ANYWH_PROFILE is set on the relay's unit, and a dev host started from a
// shell that inherited it would otherwise take over the real profile's
// socket and agents. `--profile-from-env` opts in to reading ANYWH_PROFILE
// explicitly — what `npm run start:agent-host` does, so the ANYWH_PROFILE in
// relay/.env (loaded by --env-file) names the profile, as for `npm start`. Paths default from the profile, unless the profile's env file sets:
//   ANYWH_AGENT_HOST_SOCKET    socket path (default $XDG_RUNTIME_DIR/anywh/agent-host-<profile>.sock)
//   ANYWH_AGENT_HOST_DIR       registry and logs (default ~/.anywh-sessions/<profile>-agent-host)
//   RELAY_HOME_OVERRIDE        $HOME for the agents, as for the relay's own turns
//   AGENT_BIN, EXTRA_PATH_DIRS as for the relay
//
// Hibernation and shutdown (see agentHost.ts):
//   ANYWH_AGENT_HOST_HIBERNATE          idle (default) | memory | off
//   ANYWH_AGENT_HOST_IDLE_MS            idle: quiet time before hibernating, in ms (default 600000)
//   ANYWH_AGENT_HOST_MEMORY_BYTES       memory: the machine's budget (default: total RAM)
//   ANYWH_AGENT_HOST_MEMORY_FRACTION    memory: share of it agents may use (default 0.6)
//   ANYWH_AGENT_HOST_MAX_ALIVE_PER_ROOM live agents per room (default 10)
//   ANYWH_AGENT_HOST_DRAIN_GRACE_MS     shutdown: wait for turns this long before interrupting
//                                       (default 40000; the unit's TimeoutStopSec is sized for it)
//   ANYWH_AGENT_HOST_STOP_GRACE_MS      SIGTERM → SIGKILL grace per agent (default 5000)
import { totalmem } from "node:os";
import { parseArgs } from "node:util";
import { AgentHost } from "./agentHost.js";
import { agentHostDataDir, agentHostSocketPath } from "./paths.js";
import { AGENT_MARK_ENV } from "./processTree.js";

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hibernationPolicy(): "idle" | "memory" | "off" {
  const raw = process.env.ANYWH_AGENT_HOST_HIBERNATE;
  return raw === "memory" || raw === "off" ? raw : "idle";
}

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    "profile-from-env": { type: "boolean" },
    socket: { type: "string" },
    "data-dir": { type: "string" },
    "host-id": { type: "string" },
  },
  strict: true,
});
const profile = args.profile ?? (args["profile-from-env"] ? process.env.ANYWH_PROFILE : undefined);
if (!profile || !/^[a-z0-9][a-z0-9-]*$/.test(profile)) {
  console.error(
    args["profile-from-env"]
      ? "[agent-host] --profile-from-env given but ANYWH_PROFILE is not set to a profile id (set it in relay/.env or the environment)"
      : "[agent-host] --profile <id> is required (never taken from ANYWH_PROFILE implicitly), e.g. --profile default",
  );
  process.exit(2);
}
const socketPath = args.socket ?? agentHostSocketPath(profile);
const dataDir = args["data-dir"] ?? agentHostDataDir(profile);
const hostId = args["host-id"] ?? profile;
// The host's own configuration and any agent mark it was started under are
// not passed on to what it spawns (agent children also get a fresh mark).
for (const name of ["ANYWH_PROFILE", "ANYWH_AGENT_HOST_SOCKET", "ANYWH_AGENT_HOST_DIR", "ANYWH_AGENT_HOST_ID", "ANYWH_SESSIONS_ROOT", AGENT_MARK_ENV]) {
  delete process.env[name];
}

const host = await AgentHost.start({
  hostId,
  dataDir,
  socketPath,
  homeOverride: process.env.RELAY_HOME_OVERRIDE || undefined,
  stopGraceMs: numberEnv("ANYWH_AGENT_HOST_STOP_GRACE_MS"),
  drainGraceMs: numberEnv("ANYWH_AGENT_HOST_DRAIN_GRACE_MS"),
  maxAlivePerRoom: numberEnv("ANYWH_AGENT_HOST_MAX_ALIVE_PER_ROOM"),
  hibernation: {
    policy: hibernationPolicy(),
    idleMs: numberEnv("ANYWH_AGENT_HOST_IDLE_MS"),
    memoryBytes: numberEnv("ANYWH_AGENT_HOST_MEMORY_BYTES") ?? totalmem(),
    memoryFraction: numberEnv("ANYWH_AGENT_HOST_MEMORY_FRACTION"),
  },
});
console.log(`[agent-host] profile ${profile} listening on ${host.socketPath} (pid ${process.pid})`);

let stopping = false;
const shutdown = (signalName: string, exitCode = 0): void => {
  if (stopping) return;
  stopping = true;
  console.log(`[agent-host] ${signalName}, stopping agents...`);
  void host.close().then(
    () => {
      console.log("[agent-host] exiting.");
      process.exit(exitCode);
    },
    (error: unknown) => {
      console.error("[agent-host] shutdown failed:", (error as Error).message);
      process.exit(1);
    },
  );
};
// A bug that escapes every handler must not kill the host silently and
// leave its agents running unsupervised: log it and drain like a SIGTERM
// (agents are hibernated or stopped, the registry saved), then exit
// non-zero so the service manager restarts it.
process.on("uncaughtException", (error) => {
  console.error("[agent-host] uncaught exception:", error);
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[agent-host] unhandled rejection:", reason);
  shutdown("unhandledRejection", 1);
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
