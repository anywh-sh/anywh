import { basename } from "node:path";
import { parseCliVersion, type AgentDetection } from "../runtimes/detection.js";
import { AuthNotProbableError, probeRuntimeAuth } from "../runtimes/probes/runtimeAuth.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import type { RouteHandler } from "./context.js";

/** One agent as the onboarding's "your agents" screen shows it. Unlike
 * `/host-info`'s `agents`, a CLI that isn't installed is listed too — the
 * screen offers its install link — and each installed one says whether it
 * is logged in. Display names stay in the client's dictionary. */
export interface AgentCatalogEntry {
  readonly id: string;
  /** The binary's file name, never a full path: the relay's own path layout
   * is nothing a client needs to see. */
  readonly bin: string;
  readonly installed: boolean;
  readonly version: string | null;
  /** `null` when nothing was measured: the CLI isn't installed, or it only
   * reports auth from inside a session. A probe that failed or timed out
   * is `false` — "go check your login" is the useful answer there. */
  readonly loggedIn: boolean | null;
  /** The full command line a person runs to log in, for display only. */
  readonly loginCommand: string | null;
  readonly installUrl: string | null;
}

/** What the auth probe said for one installed agent. */
export type AuthOutcome = { readonly kind: "status"; readonly loggedIn: boolean } | { readonly kind: "failed" } | { readonly kind: "unprobable" };

/** Pure: one def, its detection and (when installed) its auth outcome, in
 * the shape the endpoint answers with. */
export function catalogEntry(def: AgentRuntimeDef, detection: AgentDetection, auth: AuthOutcome | undefined): AgentCatalogEntry {
  const bin = basename(def.identity.bin);
  const loggedIn = !detection.installed || auth === undefined || auth.kind === "unprobable" ? null : auth.kind === "status" ? auth.loggedIn : false;
  return {
    id: def.identity.id,
    bin,
    installed: detection.installed,
    version: (detection.installed && parseCliVersion(detection.version)) || null,
    loggedIn,
    loginCommand: def.auth.loginCommand ? [bin, ...def.auth.loginCommand].join(" ") : null,
    installUrl: def.identity.install?.url ?? null,
  };
}

function probeAuthOutcome(def: AgentRuntimeDef, homeOverride: string | undefined): Promise<AuthOutcome> {
  return probeRuntimeAuth(def, homeOverride).then(
    (status): AuthOutcome => ({ kind: "status", loggedIn: status.loggedIn }),
    (error: unknown): AuthOutcome => {
      if (error instanceof AuthNotProbableError) return { kind: "unprobable" };
      console.warn(`[relay] ${def.identity.id} auth probe failed:`, (error as Error).message);
      return { kind: "failed" };
    },
  );
}

export const handleAgentCatalogRoutes: RouteHandler = async (req, res, ctx) => {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/control/agents") return false;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // No cache on purpose: the screen's "check again" exists for a CLI
  // installed or logged in a moment ago. The refresh also republishes
  // `/host-info`'s list, so an agent installed after boot shows up in the
  // new-session picker without restarting the relay.
  const detections = await ctx.refreshAgents();
  const entries = await Promise.all(
    detections.map(async (detection) => {
      const def = ctx.registry.get(detection.id);
      if (!def) return undefined;
      const auth = detection.installed ? await probeAuthOutcome(def, ctx.homeOverride) : undefined;
      return catalogEntry(def, detection, auth);
    }),
  );
  res.end(JSON.stringify({ agents: entries.filter((entry) => entry !== undefined) }));
  return true;
};
