import {
  authHeaders,
  resolveConnection,
} from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { getHostInfo } from "@/lib/relay/filesClient";

/**
 * Client for `GET /control/agents`: what the "Your agents" onboarding
 * screen shows, one entry per agent the relay knows how to drive. The relay
 * redoes the detection on every call (it is the only place that knows how
 * to spot a CLI or its login, so the app never duplicates that), which is
 * also why the screen offers a single "check again": the second call is
 * as fresh as the first.
 */

export interface AgentInfo {
  id: string;
  /** Basename of the CLI binary, as the reader would type it. */
  bin: string;
  installed: boolean;
  version: string | null;
  /** `null` = not installed, or the agent has no login the relay can probe. */
  loggedIn: boolean | null;
  /** Shown, never run: the app does not sign anyone in. */
  loginCommand: string | null;
  installUrl: string | null;
}

export type AgentCardState = "checking" | "ready" | "noLogin" | "missing";

export interface AgentsCatalog {
  agents: AgentInfo[];
  /** `false` when an older relay answered through `/host-info`: only the
   * installed agents are known, with no login state and no "missing" cards. */
  full: boolean;
}

export function agentCardState(agent: AgentInfo): AgentCardState {
  if (!agent.installed) return "missing";
  return agent.loggedIn === false ? "noLogin" : "ready";
}

/** An agent the reader can start with: installed, signed in or not. */
export function isSelectable(agent: AgentInfo): boolean {
  return agent.installed;
}

/** The agent to mark when the screen opens: the first one that is ready, or
 * else the first installed one (a missing login does not block starting). */
export function preselectedAgent(
  agents: readonly AgentInfo[],
): AgentInfo | null {
  return (
    agents.find((a) => agentCardState(a) === "ready") ??
    agents.find(isSelectable) ??
    null
  );
}

function isAgentInfo(value: unknown): value is AgentInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.installed === "boolean";
}

function normalize(raw: AgentInfo): AgentInfo {
  return {
    id: raw.id,
    bin: typeof raw.bin === "string" ? raw.bin : raw.id,
    installed: raw.installed,
    version: typeof raw.version === "string" ? raw.version : null,
    loggedIn: typeof raw.loggedIn === "boolean" ? raw.loggedIn : null,
    loginCommand:
      typeof raw.loginCommand === "string" ? raw.loginCommand : null,
    installUrl: typeof raw.installUrl === "string" ? raw.installUrl : null,
  };
}

/** Asks `profile`'s relay which agents it has. An older relay (no such
 * route: it answers 426 or 404) falls back to `/host-info`, which lists the
 * installed agents only. Any other failure rejects. */
export async function fetchAgentsCatalog(
  profile: Profile,
): Promise<AgentsCatalog> {
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(
    `http://${host}:${String(port)}/control/agents`,
    { headers: authHeaders(token) },
  );
  if (response.status === 404 || response.status === 426)
    return fromHostInfo(profile);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const body = (await response.json()) as { agents?: unknown };
  if (!Array.isArray(body.agents))
    throw new Error("malformed /control/agents response");
  return { agents: body.agents.filter(isAgentInfo).map(normalize), full: true };
}

async function fromHostInfo(profile: Profile): Promise<AgentsCatalog> {
  const info = await getHostInfo(profile);
  const agents = (info.agents ?? []).map((a): AgentInfo => ({
    id: a.id,
    bin: a.id,
    installed: true,
    version: a.version ?? null,
    loggedIn: null,
    loginCommand: null,
    installUrl: null,
  }));
  return { agents, full: false };
}
