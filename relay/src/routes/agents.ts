import { aggregateActivity } from "../agentHost/activity.js";
import type { AgentActivity } from "../agentHost/protocol.js";
import type { RouteHandler } from "./context.js";

/**
 * `GET /agents/activity` — what the agent host is running, per agent and in
 * aggregate, for a status display or whatever decides whether this machine
 * is busy. A thin pass-through: the host owns the agents and their state.
 * 503 while the relay is not connected to the host (not running, or from
 * another release), so a caller can tell "nothing running" from "unknown".
 */
export const handleAgentRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET" || req.url !== "/agents/activity") return false;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  let agents: AgentActivity[];
  try {
    ({ agents } = await ctx.agentHost.request<{ agents: AgentActivity[] }>("activity"));
  } catch (error) {
    res.statusCode = 503;
    res.end(JSON.stringify({ hostConnected: false, hostStatus: ctx.agentHost.status, error: (error as Error).message }));
    return true;
  }
  res.end(JSON.stringify({ hostConnected: true, aggregate: aggregateActivity(agents), agents }));
  return true;
};
