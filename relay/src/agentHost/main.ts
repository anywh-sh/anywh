// Entrypoint of the agent host service (`anywh-agent-host@<profile>`): one
// per profile, next to that profile's relay, built from the same package.
//
//   node dist/agentHost/main.js
//
// Configuration comes from the same env files as the relay's:
//   ANYWH_PROFILE              profile id (default "default")
//   ANYWH_AGENT_HOST_SOCKET    socket path (default under $XDG_RUNTIME_DIR)
//   ANYWH_AGENT_HOST_DIR       registry and logs (default ~/.anywh-sessions/<profile>-agent-host)
//   ANYWH_AGENT_HOST_ID        marker for this host's processes (default: the profile)
//   RELAY_HOME_OVERRIDE        $HOME for the agents, as for the relay's own turns
//   AGENT_BIN, EXTRA_PATH_DIRS as for the relay
//
// Hibernation (see agentHost.ts):
//   ANYWH_AGENT_HOST_HIBERNATE          idle (default) | memory | off
//   ANYWH_AGENT_HOST_IDLE_MS            idle: quiet time before hibernating, in ms (default 600000)
//   ANYWH_AGENT_HOST_MEMORY_BYTES       memory: the machine's budget (default: total RAM)
//   ANYWH_AGENT_HOST_MEMORY_FRACTION    memory: share of it agents may use (default 0.6)
//   ANYWH_AGENT_HOST_MAX_ALIVE_PER_ROOM live agents per room (default 10)
//   ANYWH_AGENT_HOST_DRAIN_GRACE_MS     shutdown: wait for turns this long before interrupting (default 120000)
//   ANYWH_AGENT_HOST_STOP_GRACE_MS      SIGTERM → SIGKILL grace per agent (default 5000)
import { totalmem } from "node:os";
import { AgentHost } from "./agentHost.js";
import { agentHostDataDir, agentHostProfile, agentHostSocketPath } from "./paths.js";

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

const profile = agentHostProfile();
const host = await AgentHost.start({
  hostId: process.env.ANYWH_AGENT_HOST_ID || profile,
  dataDir: agentHostDataDir(),
  socketPath: agentHostSocketPath(),
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
const shutdown = (signalName: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`[agent-host] ${signalName} received, stopping agents...`);
  void host.close().then(
    () => {
      console.log("[agent-host] exiting.");
      process.exit(0);
    },
    (error: unknown) => {
      console.error("[agent-host] shutdown failed:", (error as Error).message);
      process.exit(1);
    },
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
