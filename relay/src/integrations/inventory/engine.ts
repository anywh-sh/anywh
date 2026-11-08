// The profile's MCP inventory: every server each agent CLI of this profile
// would load, as the CLI itself reports it (inventory/claude.ts,
// inventory/codex.ts parse; the def's `inventory` contract says how to ask).
// One per relay — a relay serves one profile, and every process here runs
// with that profile's `$HOME`, the same env a session's agent gets.
//
// Scans, per CLI and folder (the neutral one for the servers every session
// has; a project folder for its own `.mcp.json`/local/trusted servers):
// - `static`: what costs nothing — Codex's `mcp list --json` (no server
//   started) and Claude's needs-auth cache (marks servers already known);
// - `live` (the default, static first): Claude's `mcp_status` on a fresh
//   control process, repeated while servers are `pending` up to the def's
//   `settleMs`; Codex's `mcpServerStatus/list` on the control daemon's
//   thread (neutral folder only), merged by name onto the static list.
// A failed scan keeps what the last good one found. Scans of one CLI and
// folder never overlap: one asked for while another runs runs once more
// after it.
//
// Rescans happen on demand (`scan`), when a watched config file changes
// (`start`: `fs.watch` on each file's directory, non-recursive — the CLIs
// write by tmp+rename — debounced, and only when the relevant slice of the
// files changed, by hash), and from what sessions report in band
// (`noteInBand`: a turn's `system`/`init`, Codex's startup status push).
//
// Persisting the entries is the owner's: seed them with `initial`, save
// them on `subscribe`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../../runtimes/executables.js";
import type { AgentRuntimeDef, McpInventoryContract, McpLiveReport, McpServerReport, McpWatchedFile } from "../../runtimes/types.js";
import { ClaudeControlPool } from "../claudeControl.js";
import { createCodexControl, type CodexControl } from "../codexControl.js";
import type { McpInventoryEntry, McpRuntimeId, McpServerStatus } from "../types.js";

export const INVENTORY_DEBOUNCE_MS = 1500;
export const INVENTORY_CLI_TIMEOUT_MS = 15_000;
export const INVENTORY_REQUEST_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 1000;
const MAX_LIVE_PAGES = 10;

export type InventoryScanTier = "static" | "live";

export type InventoryScanError = "timeout" | "unavailable" | "parse" | "failed";

export interface InventoryScanResult {
  readonly runtimeId: McpRuntimeId;
  readonly cwd?: string;
  readonly ok: boolean;
  readonly error?: InventoryScanError;
}

/** One CLI the inventory reads. The control processes are shared with
 * whatever else talks to the same CLI (fetching, signing in); absent, the
 * inventory starts its own. */
export interface McpInventoryRuntime {
  readonly def: AgentRuntimeDef;
  readonly claudeControl?: ClaudeControlPool;
  readonly codexControl?: CodexControl;
}

export interface McpInventoryOptions {
  readonly runtimes: readonly McpInventoryRuntime[];
  /** The profile's `$HOME` (`RELAY_HOME_OVERRIDE`); the relay's own when absent. */
  readonly homeOverride?: string;
  /** Where `CODEX_HOME`/`CLAUDE_CONFIG_DIR` are looked up; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** A folder with no project servers. The system temp dir by default. */
  readonly neutralCwd?: string;
  /** What the last run found (the owner's disk cache). */
  readonly initial?: readonly McpInventoryEntry[];
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly cliTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly settlePollMs?: number;
}

interface RuntimeState {
  readonly id: McpRuntimeId;
  readonly def: AgentRuntimeDef;
  readonly contract: McpInventoryContract;
  readonly claudeControl?: ClaudeControlPool;
  readonly codexControl?: CodexControl;
  /** Started here, so closed here. */
  readonly owned: boolean;
}

const isRuntimeId = (id: string): id is McpRuntimeId => id === "claude" || id === "codex";
const isProjectScope = (entry: { scope: string }): boolean => entry.scope === "project" || entry.scope === "local";
const signatureOf = (entries: readonly McpInventoryEntry[]): string => JSON.stringify(entries.map(({ scannedAt: _scannedAt, ...rest }) => rest));

function sortEntries(entries: McpInventoryEntry[]): McpInventoryEntry[] {
  return entries.sort(
    (a, b) => a.runtimeId.localeCompare(b.runtimeId) || (a.cwd ?? "").localeCompare(b.cwd ?? "") || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  );
}

class ScanFailed extends Error {
  constructor(readonly kind: InventoryScanError) {
    super(`inventory scan failed: ${kind}`);
  }
}

export class McpInventory {
  private entryList: McpInventoryEntry[];
  private signature: string;
  private readonly runtimes = new Map<McpRuntimeId, RuntimeState>();
  private readonly listeners = new Set<(entries: McpInventoryEntry[]) => void>();
  private readonly running = new Map<string, { promise: Promise<InventoryScanResult>; again: boolean; tier: InventoryScanTier }>();
  private readonly projects = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounces = new Map<string, NodeJS.Timeout>();
  private readonly hashes = new Map<string, string>();
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly neutralCwd: string;
  private started = false;
  private closed = false;

  constructor(private readonly options: McpInventoryOptions) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.home = options.homeOverride ?? this.env.HOME ?? homedir();
    this.neutralCwd = options.neutralCwd ?? tmpdir();
    for (const runtime of options.runtimes) {
      const id = runtime.def.identity.id;
      const { mcp } = runtime.def.portability;
      if (!isRuntimeId(id) || mcp.kind !== "supported" || !mcp.inventory) continue;
      const contract = mcp.inventory;
      if (contract.kind === "control-request") {
        const claudeControl = runtime.claudeControl ?? new ClaudeControlPool({ def: runtime.def, homeOverride: options.homeOverride, neutralCwd: this.neutralCwd });
        this.runtimes.set(id, { id, def: runtime.def, contract, claudeControl, owned: !runtime.claudeControl });
      } else {
        const codexControl = runtime.codexControl ?? createCodexControl({ def: runtime.def, homeOverride: options.homeOverride, cwd: this.neutralCwd });
        this.runtimes.set(id, { id, def: runtime.def, contract, codexControl, owned: !runtime.codexControl });
      }
    }
    this.entryList = sortEntries((options.initial ?? []).filter((entry) => this.runtimes.has(entry.runtimeId)).map((entry) => ({ ...entry })));
    this.signature = signatureOf(this.entryList);
  }

  /** Every known server, every CLI and folder. */
  entries(): McpInventoryEntry[] {
    return this.entryList.map((entry) => ({ ...entry }));
  }

  /** CLIs this inventory reads. */
  runtimeIds(): McpRuntimeId[] {
    return [...this.runtimes.keys()];
  }

  /** Called with every entry after any change (not on a rescan that found
   * the same thing). */
  subscribe(listener: (entries: McpInventoryEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scans now: every CLI, or one, in the neutral folder or `cwd` (a
   * project folder, which is then watched too). Never rejects. */
  async scan(options: { runtimeId?: McpRuntimeId; cwd?: string; tier?: InventoryScanTier } = {}): Promise<InventoryScanResult[]> {
    const cwd = options.cwd === this.neutralCwd ? undefined : options.cwd;
    if (cwd !== undefined) this.watchProject(cwd);
    const targets = [...this.runtimes.values()].filter((runtime) => options.runtimeId === undefined || runtime.id === options.runtimeId);
    return Promise.all(targets.map((runtime) => this.scanExclusive(runtime, cwd, options.tier ?? "live")));
  }

  /** What a session saw about servers of one CLI while it ran — a turn's
   * `system`/`init`, Codex's `mcpServer/startupStatus/updated` — applied to
   * the known entries. A server the inventory does not know yet makes it
   * rescan. */
  noteInBand(runtimeId: McpRuntimeId, servers: readonly { name: string; status: McpServerStatus }[], cwd?: string): void {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime || this.closed) return;
    let unknown = false;
    const next = this.entryList.map((entry) => ({ ...entry }));
    for (const update of servers) {
      const sameName = next.filter((entry) => entry.runtimeId === runtimeId && entry.name === update.name);
      const target = sameName.find((entry) => entry.cwd === cwd) ?? sameName.find((entry) => entry.cwd === undefined) ?? sameName[0];
      if (!target) {
        unknown = true;
        continue;
      }
      // `pending` is a server starting, never a verdict on one known.
      if (update.status === "pending" || target.status === update.status) continue;
      target.status = update.status;
      target.scannedAt = this.now();
    }
    this.commit(next);
    if (unknown) this.schedule(runtime, cwd, true);
  }

  /** Overrides what the CLI said about one server, for a verdict reached
   * elsewhere (a tool call refused for want of a sign-in, while the CLI
   * still says connected). */
  setStatus(runtimeId: McpRuntimeId, name: string, status: McpServerStatus, cwd?: string): void {
    this.commit(this.entryList.map((entry) => (entry.runtimeId === runtimeId && entry.name === name && entry.cwd === cwd ? { ...entry, status, scannedAt: this.now() } : { ...entry })));
  }

  /** A server the relay itself just declared in a CLI (in the neutral
   * folder), known before any scan lists it: shown at once, as not signed
   * in, until the next scan of that CLI replaces it with what the CLI
   * reports. A server already known by that name is left as it is. */
  noteDeclared(runtimeId: McpRuntimeId, server: { name: string; scope: McpInventoryEntry["scope"]; transport: McpInventoryEntry["transport"]; authMode: McpInventoryEntry["authMode"] }): void {
    if (!this.runtimes.has(runtimeId) || this.closed) return;
    if (this.entryList.some((entry) => entry.runtimeId === runtimeId && entry.name === server.name && entry.cwd === undefined)) return;
    this.commit([...this.entryList.map((entry) => ({ ...entry })), { runtimeId, ...server, status: "needs_auth", scannedAt: this.now() }]);
  }

  /** Watches the config files of every CLI. Idempotent. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    for (const runtime of this.runtimes.values()) {
      for (const file of runtime.contract.watch) this.watchFile(runtime, undefined, this.dirOf(file, undefined), file);
      void this.hashFor(runtime, undefined).then((hash) => this.hashes.set(this.key(runtime, undefined), hash));
    }
    for (const cwd of this.projects) this.watchProjectFiles(cwd);
  }

  /** Includes a project folder in rescans after a config change, and
   * watches its own server files once `start` ran. */
  watchProject(cwd: string): void {
    if (this.projects.has(cwd) || cwd === this.neutralCwd) return;
    this.projects.add(cwd);
    if (this.started) this.watchProjectFiles(cwd);
  }

  /** Stops watching, pending rescans and the control processes it started. */
  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.debounces.values()) clearTimeout(timer);
    this.debounces.clear();
    for (const runtime of this.runtimes.values()) {
      if (!runtime.owned) continue;
      runtime.claudeControl?.close();
      runtime.codexControl?.close();
    }
  }

  // --- scanning -----------------------------------------------------------

  private key(runtime: RuntimeState, cwd: string | undefined): string {
    return `${runtime.id}\u0000${cwd ?? ""}`;
  }

  private scanExclusive(runtime: RuntimeState, cwd: string | undefined, tier: InventoryScanTier): Promise<InventoryScanResult> {
    const key = this.key(runtime, cwd);
    const current = this.running.get(key);
    if (current) {
      current.again = true;
      if (tier === "live") current.tier = "live";
      // Resolves after the extra run, which sees whatever changed meanwhile.
      return current.promise;
    }
    const slot = { promise: Promise.resolve<InventoryScanResult>({ runtimeId: runtime.id, ok: true }), again: false, tier };
    const run = async (): Promise<InventoryScanResult> => {
      let result = await this.scanOnce(runtime, cwd, slot.tier);
      while (slot.again && !this.closed) {
        slot.again = false;
        result = await this.scanOnce(runtime, cwd, slot.tier);
      }
      this.running.delete(key);
      return result;
    };
    slot.promise = run();
    this.running.set(key, slot);
    return slot.promise;
  }

  private async scanOnce(runtime: RuntimeState, cwd: string | undefined, tier: InventoryScanTier): Promise<InventoryScanResult> {
    const base = { runtimeId: runtime.id, ...(cwd !== undefined ? { cwd } : {}) };
    if (this.closed) return { ...base, ok: false, error: "failed" };
    try {
      if (runtime.contract.kind === "control-request") {
        if (tier === "static") await this.applyNeedsAuthCache(runtime);
        else this.replace(runtime, cwd, await this.readControlRequest(runtime, runtime.contract, cwd));
      } else {
        const reports = await this.readCliJson(runtime, runtime.contract, cwd);
        const live = tier === "live" && cwd === undefined ? await this.readLive(runtime, runtime.contract) : undefined;
        this.replace(runtime, cwd, live ? mergeLive(reports, live) : this.keepLiveState(runtime, cwd, reports));
      }
      return { ...base, ok: true };
    } catch (error) {
      const kind = error instanceof ScanFailed ? error.kind : "failed";
      console.warn(`[relay] MCP inventory: ${runtime.id} scan${cwd !== undefined ? " (project)" : ""} failed: ${kind}`);
      return { ...base, ok: false, error: kind };
    }
  }

  private async readControlRequest(runtime: RuntimeState, contract: Extract<McpInventoryContract, { kind: "control-request" }>, cwd: string | undefined): Promise<McpServerReport[]> {
    const pool = runtime.claudeControl;
    if (!pool) throw new ScanFailed("unavailable");
    const timeoutMs = this.options.requestTimeoutMs ?? INVENTORY_REQUEST_TIMEOUT_MS;
    const ask = async (fresh: boolean): Promise<McpServerReport[]> => {
      let response: unknown;
      try {
        // A fresh process for each scan: a running one reports the servers
        // (and account connectors) it loaded when it started.
        response = await pool.request(cwd, contract.subtype, {}, { timeoutMs, fresh });
      } catch (error) {
        throw new ScanFailed(error instanceof Error && error.name === "ClaudeControlTimeout" ? "timeout" : "unavailable");
      }
      const reports = contract.parse(response);
      if (!reports) throw new ScanFailed("parse");
      return reports;
    };
    const startedAt = this.now();
    let reports = await ask(true);
    const poll = this.options.settlePollMs ?? SETTLE_POLL_MS;
    while (reports.some((report) => report.status === "pending") && this.now() - startedAt < contract.settleMs && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, poll));
      reports = await ask(false);
    }
    return reports;
  }

  private readCliJson(runtime: RuntimeState, contract: Extract<McpInventoryContract, { kind: "cli-json" }>, cwd: string | undefined): Promise<McpServerReport[]> {
    const timeoutMs = this.options.cliTimeoutMs ?? INVENTORY_CLI_TIMEOUT_MS;
    const { def } = runtime;
    return new Promise((resolve, reject) => {
      const child = spawn(resolveAgentBin(def.identity.bin), contract.args, {
        cwd: cwd ?? this.neutralCwd,
        env: buildChildEnv(
          this.options.homeOverride,
          EXTRA_PATH_DIRS,
          (env) => {
            for (const name of def.identity.env.strip) delete env[name];
          },
          def.identity.env.set,
        ),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      let settled = false;
      const settle = (error: InventoryScanError | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new ScanFailed(error));
          return;
        }
        const reports = contract.parse(stdout);
        if (reports) resolve(reports);
        else reject(new ScanFailed("parse"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle("timeout");
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", () => settle("unavailable"));
      child.on("close", (code) => settle(code === 0 ? undefined : "failed"));
    });
  }

  private async readLive(runtime: RuntimeState, contract: Extract<McpInventoryContract, { kind: "cli-json" }>): Promise<McpLiveReport[] | undefined> {
    const control = runtime.codexControl;
    if (!control) return undefined;
    const servers: McpLiveReport[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_LIVE_PAGES; page++) {
        const pageCursor = cursor;
        const parsed = contract.live.parse(await control.requestOnThread(contract.live.method, (threadId) => contract.live.params(threadId, pageCursor)));
        if (!parsed) throw new ScanFailed("parse");
        servers.push(...parsed.servers);
        cursor = parsed.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      // The declared list is still worth having without the live state.
      console.warn(`[relay] MCP inventory: ${runtime.id} live status read failed: ${error instanceof ScanFailed ? error.kind : error instanceof Error ? error.name : "error"}`);
      return undefined;
    }
    return servers;
  }

  /** A static-only scan must not erase what the last live one learned
   * about a server that is still declared the same way. */
  private keepLiveState(runtime: RuntimeState, cwd: string | undefined, reports: McpServerReport[]): McpServerReport[] {
    return reports.map((report) => {
      const known = this.entryList.find((entry) => entry.runtimeId === runtime.id && entry.name === report.name && entry.cwd === cwd);
      if (!known || JSON.stringify(known.transport) !== JSON.stringify(report.transport) || report.status !== "unknown") return report;
      return { ...report, status: known.status, ...(known.serverInfoName ? { serverInfoName: known.serverInfoName } : {}), ...(known.tools ? { tools: known.tools } : {}) };
    });
  }

  /** The Claude static tier: the CLI's own list of servers that last
   * needed a sign-in. Says nothing about a server not in it. */
  private async applyNeedsAuthCache(runtime: RuntimeState): Promise<void> {
    const { mcp } = runtime.def.portability;
    if (mcp.kind !== "supported" || mcp.needsAuthSignal.kind !== "file") return;
    let names: readonly string[];
    try {
      names = mcp.needsAuthSignal.parse(await readFile(join(this.home, mcp.needsAuthSignal.path), "utf8"));
    } catch {
      return;
    }
    const listed = new Set(names);
    this.commit(
      this.entryList.map((entry) =>
        entry.runtimeId === runtime.id && listed.has(entry.name) && (entry.status === "unknown" || entry.status === "pending") ? { ...entry, status: "needs_auth" } : { ...entry },
      ),
    );
  }

  /** Replaces what one CLI's scan of one folder owns: the neutral folder,
   * every server but a project's own; a project folder, only those. Codex
   * does not say where a server is declared, so a project's own servers
   * are the ones not also listed from the neutral folder. */
  private replace(runtime: RuntimeState, cwd: string | undefined, reports: readonly McpServerReport[]): void {
    const scannedAt = this.now();
    let owned: McpServerReport[];
    if (cwd === undefined) {
      owned = reports.filter((report) => !isProjectScope(report));
    } else if (runtime.contract.kind === "control-request") {
      owned = reports.filter(isProjectScope);
    } else {
      const global = new Set(this.entryList.filter((entry) => entry.runtimeId === runtime.id && entry.cwd === undefined).map((entry) => entry.name));
      owned = reports.filter((report) => !global.has(report.name)).map((report) => ({ ...report, scope: "project" }));
    }
    const kept = this.entryList.filter((entry) => entry.runtimeId !== runtime.id || (cwd === undefined ? entry.cwd !== undefined : entry.cwd !== cwd));
    const fresh = owned.map((report): McpInventoryEntry => ({ runtimeId: runtime.id, ...report, ...(cwd !== undefined ? { cwd } : {}), scannedAt }));
    this.commit([...kept, ...fresh]);
  }

  private commit(next: McpInventoryEntry[]): void {
    if (this.closed) return;
    const sorted = sortEntries(next);
    const signature = signatureOf(sorted);
    this.entryList = sorted;
    if (signature === this.signature) return;
    this.signature = signature;
    for (const listener of this.listeners) {
      try {
        listener(this.entries());
      } catch (error) {
        console.error("[relay] MCP inventory listener failed:", error);
      }
    }
  }

  // --- watching -----------------------------------------------------------

  private dirOf(file: McpWatchedFile, cwd: string | undefined): string {
    if (cwd !== undefined) return join(cwd, file.dir);
    const moved = file.dirEnv ? this.env[file.dirEnv.name] : undefined;
    return moved ? join(moved, file.dirEnv?.sub ?? "") : join(this.home, file.dir);
  }

  private watchProjectFiles(cwd: string): void {
    for (const runtime of this.runtimes.values()) {
      for (const file of runtime.contract.projectWatch) this.watchFile(runtime, cwd, this.dirOf(file, cwd), file);
      void this.hashFor(runtime, cwd).then((hash) => this.hashes.set(this.key(runtime, cwd), hash));
    }
  }

  private watchFile(runtime: RuntimeState, cwd: string | undefined, dir: string, file: McpWatchedFile): void {
    const id = `${this.key(runtime, cwd)}\u0000${dir}\u0000${file.file}`;
    if (this.watchers.has(id)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Some platforms omit the name; then any change in the folder counts.
        if (filename === null || filename === file.file) this.schedule(runtime, cwd, false);
      });
    } catch {
      // A directory that does not exist yet (no Codex config at all): a CLI
      // that never ran has no servers to miss.
      return;
    }
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(id);
    });
    this.watchers.set(id, watcher);
  }

  /** A debounced live rescan. `force` skips the "did the files change"
   * check (an in-band report of a server never seen). A home config file
   * of a CLI also rescans its watched projects: approvals of a project's
   * servers live there. */
  private schedule(runtime: RuntimeState, cwd: string | undefined, force: boolean): void {
    if (this.closed) return;
    const key = this.key(runtime, cwd);
    const existing = this.debounces.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounces.delete(key);
      void (async () => {
        const hash = await this.hashFor(runtime, cwd);
        if (!force && this.hashes.get(key) === hash) return;
        this.hashes.set(key, hash);
        await this.scanExclusive(runtime, cwd, "live");
        if (cwd === undefined) await Promise.all([...this.projects].map((project) => this.scanExclusive(runtime, project, "live")));
      })();
    }, this.options.debounceMs ?? INVENTORY_DEBOUNCE_MS);
    timer.unref();
    this.debounces.set(key, timer);
  }

  private async hashFor(runtime: RuntimeState, cwd: string | undefined): Promise<string> {
    const files = cwd === undefined ? runtime.contract.watch : runtime.contract.projectWatch;
    const parts = await Promise.all(
      files.map(async (file) => {
        try {
          const text = await readFile(join(this.dirOf(file, cwd), file.file), "utf8");
          return file.slice ? file.slice(text) : text;
        } catch {
          return null;
        }
      }),
    );
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
}

/** The static list with the live state of each server laid over it, by
 * name. A server only the live read knows about is left out: the static
 * list is the one that says how it is reached. */
function mergeLive(reports: readonly McpServerReport[], live: readonly McpLiveReport[]): McpServerReport[] {
  const byName = new Map(live.map((server) => [server.name, server]));
  return reports.map((report) => {
    const state = byName.get(report.name);
    if (!state) return report;
    return {
      ...report,
      status: state.status,
      ...(state.authMode ? { authMode: state.authMode } : {}),
      ...(state.serverInfoName ? { serverInfoName: state.serverInfoName } : {}),
      ...(state.tools ? { tools: state.tools } : {}),
    };
  });
}
