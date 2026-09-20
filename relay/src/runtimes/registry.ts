import { isAbsolute, normalize } from "node:path";
import type { AgentCapability, AgentRuntimeDef, BridgeId, HostPlatform } from "./types.js";

// Six values, matching `HostPlatform` in types.ts — kept here rather than
// exported from there so types.ts stays free of runtime values (see its
// header comment: nothing in that file executes).
const HOST_PLATFORMS: readonly HostPlatform[] = ["darwin", "freebsd", "linux", "openbsd", "sunos", "win32"];

// Only these two capabilities can ever be satisfied by a bridge — the other
// five (rewindTurn, replayHistory, backgroundJobs, thinking, contextUsage)
// are either an exec-plan method or plain data the def reports, never a
// bridges/ file. Extending this map is how a future bridge-backed
// capability opts into the "bridged means a real bridge exists" check.
const BRIDGE_BACKED_CAPABILITIES: Partial<Record<AgentCapability, BridgeId>> = {
  presentChoice: "mcp",
  approvalPrompt: "permission",
};

export interface CoherenceIssue {
  readonly message: string;
}

/** A path in `portability` has to stay relative to the runtime's config
 * home, because the whole point is that it resolves against a *different*
 * home than the one it was written on. An absolute path is a def that only
 * works on its author's machine — the exact bug measured inside one CLI's
 * own config file, which carries 25 absolute local project paths. `..` is
 * refused for the same reason plus a sharper one: it escapes the config
 * home entirely, and the feature that consumes this reads and writes files
 * at those paths. */
function pathIssue(field: string, path: string): CoherenceIssue | undefined {
  if (path.length === 0) return { message: `${field} is empty — a path relative to the runtime config home was expected` };
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) return { message: `${field} ("${path}") is absolute — portability paths are relative to the runtime config home` };
  if (normalize(path).split(/[\\/]/).includes("..")) return { message: `${field} ("${path}") escapes the runtime config home with ".."` };
  return undefined;
}

/**
 * Checks a def against the invariants the type system can't express on its
 * own — `PermissionPolicy.modesFor` being a function instead of data means
 * "returns at least one mode everywhere" has to be *run*, not just typed.
 * Pure and synchronous: nothing here spawns the CLI the def describes.
 */
export function assertCoherent(def: AgentRuntimeDef): readonly CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];
  const { identity, capabilities, models, auth, permissions, bridges, exec, portability } = def;

  for (const [capability, bridgeId] of Object.entries(BRIDGE_BACKED_CAPABILITIES) as [AgentCapability, BridgeId][]) {
    if (capabilities[capability] === "bridged" && !bridges.includes(bridgeId)) {
      issues.push({ message: `capabilities.${capability} is "bridged" but bridges does not include "${bridgeId}"` });
    }
  }

  if (capabilities.approvalPrompt === "native" && exec.kind !== "jsonRpcDaemon") {
    issues.push({ message: 'capabilities.approvalPrompt is "native" but exec has no server-to-client transport (exec.kind must be "jsonRpcDaemon")' });
  }

  const modesByPlatform = new Map(HOST_PLATFORMS.map((platform) => [platform, permissions.modesFor(platform)]));
  for (const [platform, modes] of modesByPlatform) {
    if (modes.length === 0) {
      issues.push({ message: `permissions.modesFor("${platform}") returns no modes — every platform needs at least one` });
    }
  }
  // The default only has to survive on *some* platform, not all of them —
  // that's what makes a platform-specific gap (Codex's workspace-write
  // missing on win32) representable instead of a coherence failure.
  const defaultSurvivesSomewhere = [...modesByPlatform.values()].some((modes) => modes.some((mode) => mode.id === permissions.defaultModeId));
  if (!defaultSurvivesSomewhere) {
    issues.push({ message: `permissions.defaultModeId ("${permissions.defaultModeId}") is not returned by modesFor on any platform` });
  }

  if (capabilities.approvalPrompt === "none") {
    const pausingMode = [...modesByPlatform.values()].flat().find((mode) => mode.pausesForApproval);
    if (pausingMode) {
      issues.push({ message: `capabilities.approvalPrompt is "none" but mode "${pausingMode.id}" has pausesForApproval: true` });
    }
  }

  if ((models.kind === "session-rpc" || auth.kind === "session-rpc") && exec.kind !== "jsonRpcDaemon") {
    issues.push({ message: 'models/auth kind "session-rpc" requires exec.kind to be "jsonRpcDaemon"' });
  }

  // rewindTurn/replayHistory only need a method when the exec plan is a
  // JSON-RPC daemon: a spawn-per-turn CLI's rewind is a relay-side
  // transcript operation (see transcriptFork.ts), never an RPC call.
  if (exec.kind === "jsonRpcDaemon") {
    if (capabilities.rewindTurn !== "none" && !exec.rewindMethod) {
      issues.push({ message: 'capabilities.rewindTurn is declared but exec.rewindMethod is missing' });
    }
    if (capabilities.replayHistory !== "none" && !exec.replayHistoryMethod) {
      issues.push({ message: 'capabilities.replayHistory is declared but exec.replayHistoryMethod is missing' });
    }
  }

  if (identity.env.strip.length === 0) {
    issues.push({ message: "identity.env.strip is empty — every runtime bills some credential if it leaks into a spawned child" });
  }

  // A runtime that names nothing the user authored is a runtime the UI can
  // never offer "bring my configuration" for. Declaring the empty list is
  // allowed to be the honest answer for a transport rather than an agent
  // (defs/acp.ts), but it has to be *noticed* — same posture as the empty
  // `env.strip` right above.
  if (portability.authoredPaths.length === 0) {
    issues.push({ message: "portability.authoredPaths is empty — a runtime with no authored config is a runtime the UI can't offer to carry" });
  }
  for (const path of portability.authoredPaths) {
    const issue = pathIssue("portability.authoredPaths entry", path);
    if (issue) issues.push(issue);
  }

  if (portability.mcp.kind === "supported") {
    const { declaration, needsAuthSignal } = portability.mcp;
    const declarationIssue = pathIssue("portability.mcp.declaration.path", declaration.path);
    if (declarationIssue) issues.push(declarationIssue);
    // A shared file is merged key by key, so an empty allowlist means the
    // merge would carry nothing — the declaration would be written and no
    // server would cross, which looks like a working feature that quietly
    // does nothing.
    if (declaration.kind === "shared" && declaration.portableKeys.length === 0) {
      issues.push({ message: 'portability.mcp.declaration is "shared" but portableKeys is empty — a merge with no keys copies nothing' });
    }
    if (needsAuthSignal.kind === "file") {
      const signalIssue = pathIssue("portability.mcp.needsAuthSignal.path", needsAuthSignal.path);
      if (signalIssue) issues.push(signalIssue);
    }
  }

  return issues;
}

export interface Registry {
  readonly defs: readonly AgentRuntimeDef[];
  get(id: string): AgentRuntimeDef | undefined;
}

export interface BuildRegistryOptions {
  /** Test-only: throw on the first incoherent def instead of excluding it.
   * Production boot always isolates the failure — a def that lies is a UI
   * that lies, and the cheapest place to stop that is before the rest of
   * the relay finishes coming up, not by refusing to come up at all. */
  readonly strict?: boolean;
}

export function buildRegistry(candidates: readonly AgentRuntimeDef[], options: BuildRegistryOptions = {}): Registry {
  const accepted: AgentRuntimeDef[] = [];
  for (const def of candidates) {
    const issues = assertCoherent(def);
    if (issues.length === 0) {
      accepted.push(def);
      continue;
    }
    const message = `runtime def "${def.identity.id}" is incoherent, excluding it from the registry: ${issues.map((issue) => issue.message).join("; ")}`;
    if (options.strict) throw new Error(message);
    console.error(message);
  }
  // Cross-def, so `assertCoherent` (which only ever sees one def) can't
  // catch it: two defs answering to the same `identity.id`. `byId` below is
  // a last-wins `Map`, so today the second one silently replaces the first
  // and every session that resolved the id before the collision existed
  // starts being driven by a different CLI — with nothing logged anywhere.
  const seen = new Set<string>();
  const unique: AgentRuntimeDef[] = [];
  for (const def of accepted) {
    if (seen.has(def.identity.id)) {
      const message = `two runtime defs share identity.id "${def.identity.id}", excluding the later one from the registry`;
      if (options.strict) throw new Error(message);
      console.error(message);
      continue;
    }
    seen.add(def.identity.id);
    unique.push(def);
  }
  const byId = new Map(unique.map((def) => [def.identity.id, def] as const));
  return { defs: unique, get: (id) => byId.get(id) };
}
