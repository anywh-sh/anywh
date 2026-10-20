import type { AgentActivity, AgentState } from "./protocol.js";

/** One word for the whole machine, for whatever decides whether it is busy
 * (an idle-suspend watchdog, a status line): someone working beats someone
 * waiting for the person, which beats nothing happening. */
export type AggregateActivity = "working" | "awaiting_user" | "idle" | "none";

const WORKING: readonly AgentState[] = ["working", "starting"];

export function aggregateActivity(agents: readonly AgentActivity[]): AggregateActivity {
  if (agents.length === 0) return "none";
  if (agents.some((agent) => WORKING.includes(agent.state))) return "working";
  if (agents.some((agent) => agent.state === "awaiting_user")) return "awaiting_user";
  return "idle";
}
