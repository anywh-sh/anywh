import { detectRuntimes, parseCliVersion, type AgentDetection } from "./detection.js";
import { hasCatalogProbe, probeModelCatalog } from "./probes/modelCatalog.js";
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
  /** Called when an agent's catalog is first known and whenever a later
   * probe finds it changed — never to repeat what was already published. */
  readonly publishModelCatalog: (agentId: string, catalog: ModelCatalog) => void;
  /** How long a catalog stays fresh. The list a CLI offers comes from its
   * server and account, so it can change without the binary changing. */
  readonly catalogTtlMs: number;
  /** The clock the TTL is measured on; `Date.now` unless a test drives it. */
  readonly now?: () => number;
  /** How long after a refresh in which some CLI's `--version` timed out
   * (with no earlier detection to fall back on) the refresher detects
   * again, on its own. Defaults to `TIMED_OUT_RETRY_MS`. */
  readonly timedOutRetryMs?: number;
}

/** What the refresher remembers about one agent's catalog probes. */
export interface CatalogProbeRecord {
  /** When the last probe settled, whether it found a catalog or not. */
  readonly at: number;
  /** The raw `--version` the last probe ran under. */
  readonly version: string | undefined;
  /** JSON of the catalog last published; absent while no probe has found one. */
  readonly published?: string;
  /** Whether the last probe found nothing while an earlier catalog stands.
   * `version` is then still the one that catalog was read under, so a CLI
   * that changed version keeps counting as due — at the failure delay. */
  readonly failed?: boolean;
}

/** A probe that found nothing (failed, timed out) is retried after this,
 * not on every refresh — each one spawns the CLI. */
export const CATALOG_RETRY_AFTER_FAILURE_MS = 60_000;

/** Whether a refresh should spend a probe on an agent now: it was never
 * probed, its CLI version changed, its catalog is past the TTL, or its last
 * probe found nothing and the retry delay has passed. */
export function catalogProbeDue(record: CatalogProbeRecord | undefined, version: string | undefined, now: number, ttlMs: number): boolean {
  if (!record) return true;
  if (record.published === undefined) return now - record.at >= CATALOG_RETRY_AFTER_FAILURE_MS;
  if (version !== record.version) return !record.failed || now - record.at >= CATALOG_RETRY_AFTER_FAILURE_MS;
  return now - record.at >= ttlMs;
}

/** The record after a probe that found nothing: an earlier catalog stays
 * published, under the version it was read with. */
function probeFoundNothing(earlier: CatalogProbeRecord | undefined, version: string | undefined, at: number): CatalogProbeRecord {
  if (earlier?.published === undefined) return { at, version };
  return { at, version: earlier.version, published: earlier.published, failed: true };
}

/** The longest delay `setInterval`/`setTimeout` take; a larger one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** A duration in ms read from an environment value: `fallback` when it is
 * unset, blank, not a number, below `min` or past what a timer can wait. */
export function parseDurationMs(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= MAX_TIMER_MS ? value : fallback;
}

/** The catalog-probe memory shared across refreshes. */
export interface CatalogProbeState {
  /** Agents whose probe is still running: a probe takes seconds and spawns
   * the CLI, so a second refresh in that window must not start another. */
  readonly probing: Set<string>;
  readonly records: Map<string, CatalogProbeRecord>;
}

/**
 * Detects which agent CLIs are installed, publishes the selectable ones and
 * the room runtimes, then probes each selectable agent's model catalog in
 * the background (a slow CLI never holds back a fast one, and never holds
 * back the returned promise either). An agent is probed the first time, when
 * its `--version` changed, once its catalog is older than `catalogTtlMs`, or
 * a minute after a probe that found nothing; a failed re-probe keeps the
 * catalog already published. Resolves with every detection, the ones not
 * installed included.
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
  state: CatalogProbeState = { probing: new Set(), records: new Map() },
): Promise<readonly AgentDetection[]> {
  const detections = (await detectRuntimes(targets.defs, targets.homeOverride)).map((detection) => {
    const earlier = previous?.get(detection.id);
    return detection.timedOut && earlier?.installed ? earlier : detection;
  });
  const selectable = detections.filter((detection) => detection.installed && targets.selectableIds.includes(detection.id));
  targets.publishSelectable(selectable.map((detection) => ({ id: detection.id, capabilities: detection.capabilities, version: parseCliVersion(detection.version) })));
  targets.publishRoomRuntimes(selectable.map((detection) => detection.id).filter((id) => targets.roomRuntimeIds.includes(id)));
  const now = targets.now ?? Date.now;
  for (const def of targets.defs) {
    if (!selectable.some((detection) => detection.id === def.identity.id)) continue;
    const id = def.identity.id;
    const version = selectable.find((detection) => detection.id === id)?.version;
    if (!hasCatalogProbe(def) || state.probing.has(id) || !catalogProbeDue(state.records.get(id), version, now(), targets.catalogTtlMs)) continue;
    state.probing.add(id);
    probeModelCatalog(def, targets.homeOverride, targets.cwd)
      .then((catalog) => {
        const earlier = state.records.get(id);
        if (catalog) {
          const json = JSON.stringify(catalog);
          state.records.set(id, { at: now(), version, published: json });
          if (json !== earlier?.published) targets.publishModelCatalog(id, catalog);
        } else {
          state.records.set(id, probeFoundNothing(earlier, version, now()));
        }
      })
      .catch((error: unknown) => {
        state.records.set(id, probeFoundNothing(state.records.get(id), version, now()));
        console.error(`[relay] failed to probe ${id} model catalog:`, error);
      })
      .finally(() => state.probing.delete(id));
  }
  return detections;
}

/** First retry after a detection that timed out; each next one waits that
 * much longer (10 s, 20 s, 30 s). */
const TIMED_OUT_RETRY_MS = 10_000;
const TIMED_OUT_RETRIES = 3;

/** What `createAgentRefresher` hands back. */
export interface AgentRefresher {
  /** Detects and publishes, serialized as described on `createAgentRefresher`. */
  readonly refresh: () => Promise<readonly AgentDetection[]>;
  /** Whether a selectable agent's catalog is missing or past its TTL, judged
   * from memory alone — nothing is spawned. A cheap gate for callers that
   * would otherwise refresh on every event. */
  readonly catalogsDue: () => boolean;
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
export function createAgentRefresher(targets: SelectableAgentsTargets): AgentRefresher {
  let last = new Map<string, AgentDetection>();
  const state: CatalogProbeState = { probing: new Set(), records: new Map() };
  let running: Promise<readonly AgentDetection[]> | undefined;
  let queued: Promise<readonly AgentDetection[]> | undefined;
  let timedOutRetries = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  // A CLI that was slow to answer `--version` once (Kimi Code's takes about
  // a second idle, more while two relays boot side by side) would otherwise
  // stay out of the picker until the hourly refresh — nothing else detects
  // again for an agent that was never found. A few retries, spaced out, give
  // it its chance; a CLI that really hangs stops costing anything after them.
  const retryTimedOut = (detections: readonly AgentDetection[]): void => {
    const unanswered = detections.some((detection) => detection.timedOut && !detection.installed && targets.selectableIds.includes(detection.id));
    if (!unanswered) {
      timedOutRetries = 0;
      return;
    }
    if (timedOutRetries >= TIMED_OUT_RETRIES || retryTimer) return;
    timedOutRetries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      refresh().catch((error: unknown) => console.error("[relay] failed to detect agent runtimes:", error));
    }, (targets.timedOutRetryMs ?? TIMED_OUT_RETRY_MS) * timedOutRetries);
    retryTimer.unref();
  };

  const run = (): Promise<readonly AgentDetection[]> => {
    running = refreshSelectableAgents(targets, last, state)
      .then((detections) => {
        last = new Map(detections.map((detection) => [detection.id, detection]));
        retryTimedOut(detections);
        return detections;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const refresh = (): Promise<readonly AgentDetection[]> => {
    if (!running) return run();
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return run();
      });
    return queued;
  };

  return {
    refresh,
    catalogsDue: () => {
      const now = (targets.now ?? Date.now)();
      return targets.defs.some((def) => {
        const detection = last.get(def.identity.id);
        if (!detection?.installed || !targets.selectableIds.includes(def.identity.id)) return false;
        if (!hasCatalogProbe(def) || state.probing.has(def.identity.id)) return false;
        return catalogProbeDue(state.records.get(def.identity.id), detection.version, now, targets.catalogTtlMs);
      });
    },
  };
}
