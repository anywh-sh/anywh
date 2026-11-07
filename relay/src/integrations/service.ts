// The integrations service: one per relay process, so one per profile. It
// turns the MCP inventory into the integrations the client shows (which
// server of each agent CLI an integration runs through, and its state),
// keeps the tickets read through them, and the person's choices, and tells
// subscribers when any of it changes.
//
// Reads happen only when a client asks — opening the panel (`force:
// false`: the cache is served, and read only when there is none; a ticket
// screen also revalidates past the floor) or pressing ↻ (`force: true`,
// refused before `refreshableAt`). There is no timer: a cached list never
// expires, it only grows older on screen. One read per query at a time;
// a second ask joins it.
//
// The WebSocket (`/integrations/watch`) sits on top of `subscribe`/
// `getSnapshot`/`connectClient`/`refresh`/`loadMore`/`setPrefs`; nothing
// here knows about sockets, processes or a tracker's tools — reading is the
// `IntegrationReader`'s.
import { tmpdir } from "node:os";
import type { AgentRuntimeDef } from "../runtimes/types.js";
import { ClaudeControlPool, claudeControlArgs } from "./claudeControl.js";
import { createCodexControl } from "./codexControl.js";
import { McpInventory } from "./inventory/engine.js";
import { createIntegrationReader } from "./reader.js";
import { RuntimeToolCaller } from "./toolCaller.js";
import { JIRA_RECOGNIZER, integrationRuntimes, pickIntegration, type IntegrationPick, type IntegrationRecognizer } from "./match.js";
import { PROJECT_KEY_PATTERN, createFileIntegrationsStore, integrationsPathFor, type IntegrationsStore, type PersistedIntegration, type PersistedQuery } from "./store.js";
import {
  TICKET_KEY_PATTERN,
  type IntegrationPrefs,
  type IntegrationProvider,
  type IntegrationQueryError,
  type IntegrationQueryKind,
  type IntegrationQueryStatus,
  type IntegrationReadSource,
  type IntegrationSite,
  type IntegrationState,
  type IntegrationsServerMessage,
  type McpInventoryEntry,
  type McpRuntimeId,
  type QueryState,
  type TicketDetail,
  type TicketRow,
} from "./types.js";

/** Minimum time between two forced reads of one query. A read costs no
 * model call on either CLI — only the tracker's own latency and rate
 * limits — so this only keeps a burst of presses (several devices, a
 * reconnecting client) from becoming a burst of calls. */
export const INTEGRATIONS_FORCE_FLOOR_MS = 15_000;
export const INTEGRATIONS_FORCE_FLOOR_ENV = "ANYWH_INTEGRATIONS_FORCE_FLOOR_MS";
/** A client connecting rescans the inventory unless one ran this recently;
 * between connections, config file changes rescan on their own. */
export const INTEGRATIONS_RESCAN_AFTER_MS = 60_000;
/** Ticket screens kept in the cache (and on disk); the least recently read
 * goes first. */
export const MAX_CACHED_TICKETS = 100;

/** The force floor, overridable by its env var (a non-negative integer of
 * ms; anything else keeps the default). */
export function integrationsForceFloorFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INTEGRATIONS_FORCE_FLOOR_ENV]?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : INTEGRATIONS_FORCE_FLOOR_MS;
}

/** The integrations this relay knows, by id. */
export interface IntegrationDefinition {
  readonly id: string;
  readonly provider: IntegrationProvider;
  readonly recognizer: IntegrationRecognizer;
}

export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = [{ id: "jira", provider: "jira", recognizer: JIRA_RECOGNIZER }];

/** One read the reader is asked for. `pageToken` continues a `mine` list. */
export interface IntegrationReadRequest {
  readonly integrationId: string;
  readonly provider: IntegrationProvider;
  readonly query: IntegrationQueryKind;
  readonly param: string | null;
  readonly pageToken?: string;
}

/** What the reader is given to decide where to read: the servers picked per
 * CLI (installed CLIs only) and the site last read, if any. */
export interface IntegrationReadContext {
  readonly picks: readonly IntegrationPick[];
  readonly site?: IntegrationSite;
}

export type IntegrationReadResult =
  | {
      readonly ok: true;
      readonly runtimeId: McpRuntimeId;
      /** The site the read went to, when it had to find it out. */
      readonly site?: IntegrationSite;
      readonly items?: TicketRow[];
      readonly nextPageToken?: string;
      readonly detail?: TicketDetail;
    }
  | { readonly ok: false; readonly status: "needs_auth" | "error"; readonly error: IntegrationQueryError; readonly site?: IntegrationSite };

export interface IntegrationReader {
  /** Never rejects: a failure is a result. */
  read(request: IntegrationReadRequest, context: IntegrationReadContext): Promise<IntegrationReadResult>;
  close?(): void;
}

/** The part of `McpInventory` the service uses. */
export interface IntegrationInventory {
  entries(): McpInventoryEntry[];
  subscribe(listener: (entries: McpInventoryEntry[]) => void): () => void;
  scan(options?: { runtimeId?: McpRuntimeId }): Promise<unknown>;
  start(): void;
  close(): void;
}

export interface IntegrationServiceDeps {
  readonly inventory: IntegrationInventory;
  /** Absent: nothing is ever read (the integrations still show). */
  readonly reader?: IntegrationReader;
  readonly store?: IntegrationsStore;
  /** What the store held at boot, when the caller already loaded it (to
   * seed the inventory with the same read). */
  readonly stored?: ReturnType<IntegrationsStore["load"]>;
  readonly now?: () => number;
  readonly forceFloorMs?: number;
  readonly rescanAfterMs?: number;
  readonly definitions?: readonly IntegrationDefinition[];
  readonly log?: (line: string) => void;
}

export type IntegrationsStateMessage = Extract<IntegrationsServerMessage, { type: "integrations_state" }>;
export type IntegrationsListener = (message: IntegrationsStateMessage) => void;

/** What became of an ask: a read ran (or was joined), the cache answered,
 * the floor refused it, or there is nothing to read with. */
export type IntegrationRefreshOutcome = "read" | "joined" | "cached" | "refused" | "unavailable";

interface QuerySlot {
  readonly query: IntegrationQueryKind;
  readonly param: string | null;
  status: IntegrationQueryStatus;
  error?: IntegrationQueryError;
  source?: IntegrationReadSource;
  observedAt?: number;
  items?: TicketRow[];
  nextPageToken?: string;
  detail?: TicketDetail;
  inFlight?: Promise<void>;
  readingSince?: number;
  /** When the last read that counts for the floor started. */
  lastCallAt?: number;
  /** When the read whose data is shown started: an older one finishing
   * later is dropped. */
  appliedFrom?: number;
}

interface IntegrationSlot {
  readonly definition: IntegrationDefinition;
  site?: IntegrationSite;
  prefs: IntegrationPrefs;
  readonly queries: Map<string, QuerySlot>;
}

const slotKey = (query: IntegrationQueryKind, param: string | null): string => `${query}\u0000${param ?? ""}`;
const RUNTIME_ORDER: readonly McpRuntimeId[] = ["codex", "claude"];

/** A `param` the query accepts: a project key (or `null`) for `mine`, a
 * ticket key for `ticket`. */
function validParam(query: IntegrationQueryKind, param: string | null): boolean {
  if (query === "mine") return param === null || PROJECT_KEY_PATTERN.test(param);
  return param !== null && TICKET_KEY_PATTERN.test(param);
}

export class IntegrationService {
  private readonly integrations = new Map<string, IntegrationSlot>();
  private readonly listeners = new Set<IntegrationsListener>();
  private readonly now: () => number;
  private readonly forceFloorMs: number;
  private readonly rescanAfterMs: number;
  private installed: Set<McpRuntimeId> | undefined;
  private entries: McpInventoryEntry[];
  private clients = 0;
  private lastScanAt: number | undefined;
  private scanning: Promise<unknown> | undefined;
  private started = false;
  private closed = false;
  private readonly unsubscribeInventory: () => void;

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.forceFloorMs = deps.forceFloorMs ?? INTEGRATIONS_FORCE_FLOOR_MS;
    this.rescanAfterMs = deps.rescanAfterMs ?? INTEGRATIONS_RESCAN_AFTER_MS;
    const stored = deps.stored !== undefined ? deps.stored : deps.store?.load();
    for (const definition of deps.definitions ?? INTEGRATION_DEFINITIONS) {
      const persisted = stored?.integrations[definition.id];
      const slot: IntegrationSlot = { definition, prefs: persisted?.prefs ?? { project: null }, queries: new Map(), ...(persisted?.site ? { site: persisted.site } : {}) };
      for (const query of persisted?.queries ?? []) slot.queries.set(slotKey(query.query, query.param), restoredSlot(query));
      this.integrations.set(definition.id, slot);
    }
    this.entries = deps.inventory.entries();
    this.unsubscribeInventory = deps.inventory.subscribe((entries) => {
      this.entries = entries;
      this.persist();
      this.notify();
    });
  }

  /** The agent CLIs installed on this relay; only their servers count.
   * Until the first call, every CLI the inventory knows does. */
  setInstalledRuntimes(runtimes: readonly string[]): void {
    const next = new Set(RUNTIME_ORDER.filter((runtime) => runtimes.includes(runtime)));
    const before = this.installed;
    this.installed = next;
    if (before && before.size === next.size && [...next].every((runtime) => before.has(runtime))) return;
    this.notify();
  }

  getSnapshot(): IntegrationsStateMessage {
    const now = this.now();
    return { type: "integrations_state", integrations: [...this.integrations.values()].map((slot) => this.present(slot, now)) };
  }

  /** Called with the snapshot on every change. */
  subscribe(listener: IntegrationsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A client started watching: config files are watched from then on, and
   * the inventory is rescanned unless that happened a moment ago. The
   * returned function releases it (safe to call twice). */
  connectClient(): () => void {
    this.clients += 1;
    if (!this.started && !this.closed) {
      this.started = true;
      this.deps.inventory.start();
    }
    if (this.clients === 1) void this.rescanIfStale();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.clients -= 1;
    };
  }

  get connectedClients(): number {
    return this.clients;
  }

  /** Rescans the inventory now (joined if one is running). */
  rescan(): Promise<unknown> {
    if (this.scanning) return this.scanning;
    this.lastScanAt = this.now();
    const scan = this.deps.inventory
      .scan()
      .catch((error: unknown) => this.deps.log?.(`[integrations] inventory scan failed: ${(error as Error).message}`))
      .finally(() => {
        this.scanning = undefined;
      });
    this.scanning = scan;
    return scan;
  }

  private rescanIfStale(): Promise<unknown> {
    if (this.lastScanAt !== undefined && this.now() - this.lastScanAt < this.rescanAfterMs) return Promise.resolve();
    return this.rescan();
  }

  /** The person's choices for one integration. `false` for an unknown
   * integration or a project that is not a project key. */
  setPrefs(id: string, prefs: IntegrationPrefs): boolean {
    const slot = this.integrations.get(id);
    if (!slot || !(prefs.project === null || PROJECT_KEY_PATTERN.test(prefs.project))) return false;
    if (slot.prefs.project === prefs.project) return true;
    slot.prefs = { project: prefs.project };
    this.persist();
    this.notify();
    return true;
  }

  /** Reads one query, or says why the cache answers instead. Resolves when
   * the read it started (or joined) ends. */
  refresh(request: { id: string; query: IntegrationQueryKind; param: string | null; force: boolean }): Promise<IntegrationRefreshOutcome> {
    const integration = this.integrations.get(request.id);
    if (!integration || !validParam(request.query, request.param)) return Promise.resolve("unavailable");
    const key = slotKey(request.query, request.param);
    const existing = integration.queries.get(key);
    if (existing?.inFlight) return existing.inFlight.then(() => "joined" as const);
    const now = this.now();
    const hasData = existing?.observedAt !== undefined;
    const floor = existing?.lastCallAt !== undefined ? existing.lastCallAt + this.forceFloorMs : undefined;
    if (request.force) {
      if (floor !== undefined && floor > now) {
        this.deps.log?.(`[integrations] ${request.id} ${request.query} refresh refused (${Math.ceil((floor - now) / 1000)}s to go)`);
        return Promise.resolve("refused");
      }
    } else if (hasData && (request.query === "mine" || (floor !== undefined && floor > now))) {
      // A list is served as cached; a ticket screen revalidates past the floor.
      return Promise.resolve("cached");
    }
    if (!this.deps.reader) return Promise.resolve("unavailable");
    const slot = existing ?? this.newSlot(integration, request.query, request.param);
    return this.read(integration, slot, request.force ? "manual" : "open", undefined).then(() => "read" as const);
  }

  /** Appends the next page of a `mine` list. No floor: it is new data. */
  loadMore(request: { id: string; param: string | null }): Promise<IntegrationRefreshOutcome> {
    const integration = this.integrations.get(request.id);
    if (!integration || !validParam("mine", request.param)) return Promise.resolve("unavailable");
    const slot = integration.queries.get(slotKey("mine", request.param));
    if (!slot) return Promise.resolve("unavailable");
    if (slot.inFlight) return slot.inFlight.then(() => "joined" as const);
    if (!slot.nextPageToken || !this.deps.reader) return Promise.resolve("cached");
    return this.read(integration, slot, slot.source ?? "open", slot.nextPageToken).then(() => "read" as const);
  }

  close(): void {
    this.closed = true;
    this.unsubscribeInventory();
    this.deps.inventory.close();
    this.deps.reader?.close?.();
    this.listeners.clear();
  }

  // --- reading -------------------------------------------------------------

  private newSlot(integration: IntegrationSlot, query: IntegrationQueryKind, param: string | null): QuerySlot {
    const slot: QuerySlot = { query, param, status: "unknown" };
    integration.queries.set(slotKey(query, param), slot);
    if (query === "ticket") this.evictTickets(integration);
    return slot;
  }

  private evictTickets(integration: IntegrationSlot): void {
    const tickets = [...integration.queries.entries()].filter(([, slot]) => slot.query === "ticket" && !slot.inFlight);
    if (tickets.length <= MAX_CACHED_TICKETS) return;
    tickets.sort(([, a], [, b]) => (a.observedAt ?? 0) - (b.observedAt ?? 0));
    for (const [key] of tickets.slice(0, tickets.length - MAX_CACHED_TICKETS)) integration.queries.delete(key);
  }

  private read(integration: IntegrationSlot, slot: QuerySlot, source: IntegrationReadSource, pageToken: string | undefined): Promise<void> {
    const reader = this.deps.reader;
    if (!reader) return Promise.resolve();
    const startedAt = this.now();
    slot.readingSince = startedAt;
    // Only a read of the first page counts for the floor: "load more" is
    // not a refresh.
    if (pageToken === undefined) slot.lastCallAt = startedAt;
    const request: IntegrationReadRequest = {
      integrationId: integration.definition.id,
      provider: integration.definition.provider,
      query: slot.query,
      param: slot.param,
      ...(pageToken !== undefined ? { pageToken } : {}),
    };
    const context: IntegrationReadContext = { picks: this.picks(integration), ...(integration.site ? { site: integration.site } : {}) };
    const run = reader
      .read(request, context)
      .catch((error: unknown): IntegrationReadResult => ({ ok: false, status: "error", error: { kind: "tool", message: (error as Error).message } }))
      .then((result) => {
        slot.inFlight = undefined;
        slot.readingSince = undefined;
        if (this.closed) return;
        this.ingest(integration, slot, result, { startedAt, source, append: pageToken !== undefined });
        this.persist();
        this.notify();
      });
    slot.inFlight = run;
    this.notify();
    return run;
  }

  private ingest(integration: IntegrationSlot, slot: QuerySlot, result: IntegrationReadResult, read: { startedAt: number; source: IntegrationReadSource; append: boolean }): void {
    if (result.site && (integration.site?.id !== result.site.id || integration.site.url !== result.site.url || integration.site.name !== result.site.name)) integration.site = { ...result.site };
    if (slot.appliedFrom !== undefined && read.startedAt < slot.appliedFrom) return;
    if (!result.ok) {
      // The last good data stays, marked by the failure.
      slot.status = result.status;
      slot.error = { ...result.error };
      return;
    }
    slot.appliedFrom = read.startedAt;
    slot.status = "ok";
    delete slot.error;
    slot.source = read.source;
    slot.observedAt = this.now();
    if (slot.query === "mine") {
      const page = (result.items ?? []).filter((row) => row.statusCategory !== "done");
      if (read.append) {
        const known = new Set((slot.items ?? []).map((row) => row.key));
        slot.items = [...(slot.items ?? []), ...page.filter((row) => !known.has(row.key))];
      } else {
        // A refresh is the first page again: the extra pages go.
        slot.items = page;
      }
      if (result.nextPageToken) slot.nextPageToken = result.nextPageToken;
      else delete slot.nextPageToken;
    } else if (result.detail) {
      slot.detail = result.detail;
    }
  }

  // --- presenting ----------------------------------------------------------

  private picks(integration: IntegrationSlot): IntegrationPick[] {
    const entries = this.installed ? this.entries.filter((entry) => this.installed?.has(entry.runtimeId)) : this.entries;
    return pickIntegration(entries, integration.definition.recognizer);
  }

  private present(integration: IntegrationSlot, now: number): IntegrationState {
    const picks = this.picks(integration);
    const fetchRuntime = RUNTIME_ORDER.find((runtimeId) => picks.some((pick) => pick.runtimeId === runtimeId && pick.status === "connected"));
    return {
      id: integration.definition.id,
      provider: integration.definition.provider,
      runtimes: integrationRuntimes(picks),
      ...(fetchRuntime ? { fetchRuntime } : {}),
      ...(integration.site ? { site: { ...integration.site } } : {}),
      prefs: { ...integration.prefs },
      queries: [...integration.queries.values()].map((slot) => this.presentQuery(slot, now)),
    };
  }

  private presentQuery(slot: QuerySlot, now: number): QueryState {
    const base = {
      status: slot.status,
      ...(slot.error ? { error: { ...slot.error } } : {}),
      ...(slot.source ? { source: slot.source } : {}),
      ...(slot.observedAt !== undefined ? { observedAt: slot.observedAt } : {}),
      reading: slot.readingSince !== undefined,
      ...(slot.readingSince !== undefined ? { readingSince: slot.readingSince } : {}),
      ...(slot.lastCallAt !== undefined && slot.lastCallAt + this.forceFloorMs > now ? { refreshableAt: slot.lastCallAt + this.forceFloorMs } : {}),
    };
    if (slot.query === "mine") {
      return { ...base, query: "mine", param: slot.param, ...(slot.items ? { items: slot.items } : {}), ...(slot.nextPageToken ? { nextPageToken: slot.nextPageToken } : {}) };
    }
    return { ...base, query: "ticket", param: slot.param ?? "", ...(slot.detail ? { detail: slot.detail } : {}) };
  }

  private notify(): void {
    if (this.closed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        // A subscriber's failure is its own.
        console.error("[relay] integrations listener failed:", error);
      }
    }
  }

  private persist(): void {
    const store = this.deps.store;
    if (!store || this.closed) return;
    const integrations: Record<string, PersistedIntegration> = {};
    for (const [id, slot] of this.integrations) {
      integrations[id] = { ...(slot.site ? { site: slot.site } : {}), prefs: slot.prefs, queries: [...slot.queries.values()].flatMap(persistedQuery) };
    }
    try {
      store.save({ inventory: this.entries, integrations });
    } catch (error) {
      console.error("[relay] could not save the integrations state:", (error as Error).message);
    }
  }
}

function restoredSlot(query: PersistedQuery): QuerySlot {
  const base = { status: "ok" as const, observedAt: query.observedAt, ...(query.source ? { source: query.source } : {}) };
  if (query.query === "mine") return { ...base, query: "mine", param: query.param, items: query.items, ...(query.nextPageToken ? { nextPageToken: query.nextPageToken } : {}) };
  return { ...base, query: "ticket", param: query.param, detail: query.detail };
}

/** Only good data is kept; a slot that never read anything leaves nothing. */
function persistedQuery(slot: QuerySlot): PersistedQuery[] {
  if (slot.observedAt === undefined) return [];
  const source = slot.source ? { source: slot.source } : {};
  if (slot.query === "mine") {
    return [{ query: "mine", param: slot.param, items: slot.items ?? [], ...(slot.nextPageToken ? { nextPageToken: slot.nextPageToken } : {}), observedAt: slot.observedAt, ...source }];
  }
  if (!slot.detail || slot.param === null) return [];
  return [{ query: "ticket", param: slot.param, detail: slot.detail, observedAt: slot.observedAt, ...source }];
}

// --- wiring ------------------------------------------------------------------

export interface CreateIntegrationServiceOptions {
  /** The agent CLIs whose MCP servers count (each def's `inventory` says how
   * to list them). */
  readonly defs: readonly AgentRuntimeDef[];
  /** The profile's `$HOME` (`RELAY_HOME_OVERRIDE`); the relay's own when absent. */
  readonly homeOverride?: string;
  /** The relay's sessions file; the state is stored beside it. */
  readonly sessionsFile: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
}

/** The service with its real inventory, reader and store. Nothing runs
 * until a client connects. */
export function createIntegrationService(options: CreateIntegrationServiceOptions): IntegrationService {
  const env = options.env ?? process.env;
  const store = createFileIntegrationsStore(integrationsPathFor(options.sessionsFile));
  const stored = store.load();
  const neutralCwd = tmpdir();
  // One set of control processes per profile, shared by listing servers and
  // calling their tools.
  const claudeDef = options.defs.find((def) => def.identity.id === "claude" && claudeControlArgs(def) !== undefined);
  const codexDef = options.defs.find((def) => def.identity.id === "codex");
  const claudePool = claudeDef ? new ClaudeControlPool({ def: claudeDef, homeOverride: options.homeOverride, neutralCwd }) : undefined;
  const codexControl = codexDef ? createCodexControl({ def: codexDef, homeOverride: options.homeOverride, cwd: neutralCwd }) : undefined;
  const inventory = new McpInventory({
    runtimes: options.defs.map((def) => ({ def, ...(def === claudeDef && claudePool ? { claudeControl: claudePool } : {}), ...(def === codexDef && codexControl ? { codexControl } : {}) })),
    ...(options.homeOverride !== undefined ? { homeOverride: options.homeOverride } : {}),
    env,
    neutralCwd,
    initial: stored?.inventory ?? [],
  });
  const caller = new RuntimeToolCaller({
    defs: options.defs,
    ...(options.homeOverride !== undefined ? { homeOverride: options.homeOverride } : {}),
    ...(claudePool ? { claudePool } : {}),
    ...(codexControl ? { codexControl } : {}),
    neutralCwd,
  });
  const reader = createIntegrationReader(caller);
  return new IntegrationService({
    inventory: {
      entries: () => inventory.entries(),
      subscribe: (listener) => inventory.subscribe(listener),
      scan: (scan) => inventory.scan(scan),
      start: () => inventory.start(),
      close: () => {
        inventory.close();
        claudePool?.close();
        codexControl?.close();
      },
    },
    reader,
    store,
    stored,
    forceFloorMs: integrationsForceFloorFromEnv(env),
    ...(options.log ? { log: options.log } : {}),
  });
}
