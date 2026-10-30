import { detectRuntimes, parseCliVersion, type AgentDetection } from "./detection.js";
import { probeModelCatalog } from "./probes/modelCatalog.js";
import type { AgentRuntimeDef, Capabilities, ModelCatalog } from "./types.js";

/** What `/host-info` lists per agent — structurally the same shape as
 * `routes/host.ts`'s `SelectableAgentInfo`, declared here so this folder
 * never imports a route module. */
export interface SelectableAgent {
  readonly id: string;
  readonly capabilities: Capabilities;
  readonly version?: string;
}

/** Where a refresh writes what it found. Every target is a callback so the
 * state it updates (the `/host-info` list, the room runtimes, the model
 * catalogs) stays owned by the composition root, server.ts. */
export interface SelectableAgentsTargets {
  readonly defs: readonly AgentRuntimeDef[];
  /** The agent ids a client may pick for a session; detection filters
   * further on `installed`. */
  readonly selectableIds: readonly string[];
  /** The agent ids a room may run (`HOST_RUNTIMES`). */
  readonly roomRuntimeIds: readonly string[];
  readonly homeOverride: string | undefined;
  /** The cwd a model-catalog probe runs in. */
  readonly cwd: string;
  readonly publishSelectable: (agents: readonly SelectableAgent[]) => void;
  readonly publishRoomRuntimes: (ids: readonly string[]) => void;
  readonly publishModelCatalog: (agentId: string, catalog: ModelCatalog) => void;
  /** An agent whose catalog is already known is not probed again — a
   * refresh after boot only spends a probe on an agent that just appeared
   * (or whose earlier probe came back empty). */
  readonly hasModelCatalog?: (agentId: string) => boolean;
}

/**
 * Detects which agent CLIs are installed, publishes the selectable ones and
 * the room runtimes, then probes each selectable agent's model catalog in
 * the background (a slow CLI never holds back a fast one, and never holds
 * back the returned promise either). Resolves with every detection, the
 * ones not installed included.
 *
 * `previous` is what the last refresh found. A CLI that was installed then
 * and only timed out now keeps its earlier detection: a `--version` slow
 * under load must not take a working agent out of the new-session picker
 * and the rooms. Only a definite failure (not found, non-zero exit)
 * removes it.
 */
export async function refreshSelectableAgents(
  targets: SelectableAgentsTargets,
  previous?: ReadonlyMap<string, AgentDetection>,
  /** Agents whose catalog probe is still running, shared across calls: a
   * probe takes seconds and spawns the CLI, so a second refresh in that
   * window must not start another one. */
  probing: Set<string> = new Set(),
): Promise<readonly AgentDetection[]> {
  const detections = (await detectRuntimes(targets.defs, targets.homeOverride)).map((detection) => {
    const earlier = previous?.get(detection.id);
    return detection.timedOut && earlier?.installed ? earlier : detection;
  });
  const selectable = detections.filter((detection) => detection.installed && targets.selectableIds.includes(detection.id));
  targets.publishSelectable(selectable.map((detection) => ({ id: detection.id, capabilities: detection.capabilities, version: parseCliVersion(detection.version) })));
  targets.publishRoomRuntimes(selectable.map((detection) => detection.id).filter((id) => targets.roomRuntimeIds.includes(id)));
  for (const def of targets.defs) {
    if (!selectable.some((detection) => detection.id === def.identity.id)) continue;
    const id = def.identity.id;
    if (targets.hasModelCatalog?.(id) || probing.has(id)) continue;
    probing.add(id);
    probeModelCatalog(def, targets.homeOverride, targets.cwd)
      .then((catalog) => {
        if (!catalog) return;
        targets.publishModelCatalog(id, catalog);
      })
      .catch((error: unknown) => {
        console.error(`[relay] failed to probe ${id} model catalog:`, error);
      })
      .finally(() => probing.delete(id));
  }
  return detections;
}

/**
 * `refreshSelectableAgents` with memory: each call hands it what the last
 * one found, so a timeout keeps an agent instead of dropping it. One per
 * relay, owned by the composition root.
 *
 * Calls never overlap. One made while a refresh runs waits for a single
 * follow-up refresh, shared by every call made in the meantime: it starts
 * after the running one, so it still sees a CLI installed a moment ago,
 * and two refreshes can't finish out of order and publish a stale answer.
 */
export function createAgentRefresher(targets: SelectableAgentsTargets): () => Promise<readonly AgentDetection[]> {
  let last = new Map<string, AgentDetection>();
  const probing = new Set<string>();
  let running: Promise<readonly AgentDetection[]> | undefined;
  let queued: Promise<readonly AgentDetection[]> | undefined;

  const run = (): Promise<readonly AgentDetection[]> => {
    running = refreshSelectableAgents(targets, last, probing)
      .then((detections) => {
        last = new Map(detections.map((detection) => [detection.id, detection]));
        return detections;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return () => {
    if (!running) return run();
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return run();
      });
    return queued;
  };
}
