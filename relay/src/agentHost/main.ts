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
import { AgentHost } from "./agentHost.js";
import { agentHostDataDir, agentHostProfile, agentHostSocketPath } from "./paths.js";

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const profile = agentHostProfile();
const host = await AgentHost.start({
  hostId: process.env.ANYWH_AGENT_HOST_ID || profile,
  dataDir: agentHostDataDir(),
  socketPath: agentHostSocketPath(),
  homeOverride: process.env.RELAY_HOME_OVERRIDE || undefined,
  stopGraceMs: numberEnv("ANYWH_AGENT_HOST_STOP_GRACE_MS"),
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
