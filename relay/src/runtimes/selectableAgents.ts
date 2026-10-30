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
 */
export async function refreshSelectableAgents(targets: SelectableAgentsTargets): Promise<readonly AgentDetection[]> {
  const detections = await detectRuntimes(targets.defs, targets.homeOverride);
  const selectable = detections.filter((detection) => detection.installed && targets.selectableIds.includes(detection.id));
  targets.publishSelectable(selectable.map((detection) => ({ id: detection.id, capabilities: detection.capabilities, version: parseCliVersion(detection.version) })));
  targets.publishRoomRuntimes(selectable.map((detection) => detection.id).filter((id) => targets.roomRuntimeIds.includes(id)));
  for (const def of targets.defs) {
    if (!selectable.some((detection) => detection.id === def.identity.id)) continue;
    if (targets.hasModelCatalog?.(def.identity.id)) continue;
    probeModelCatalog(def, targets.homeOverride, targets.cwd)
      .then((catalog) => {
        if (!catalog) return;
        targets.publishModelCatalog(def.identity.id, catalog);
      })
      .catch((error: unknown) => {
        console.error(`[relay] failed to probe ${def.identity.id} model catalog:`, error);
      });
  }
  return detections;
}
