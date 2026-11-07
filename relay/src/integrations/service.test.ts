// The integrations service against an inventory and a reader written here,
// and a clock stepped by hand. Pure — no process, no file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeMcpStatus } from "./inventory/claude.js";
import { CLAUDE_MCP_STATUS_SETTLED } from "./inventory/fixtures.js";
import {
  INTEGRATIONS_FORCE_FLOOR_ENV,
  INTEGRATIONS_FORCE_FLOOR_MS,
  IntegrationService,
  integrationsForceFloorFromEnv,
  type IntegrationInventory,
  type IntegrationReadRequest,
  type IntegrationReadResult,
  type IntegrationsStateMessage,
} from "./service.js";
import type { IntegrationsStore, PersistedIntegrations } from "./store.js";
import type { McpInventoryEntry, QueryState, TicketRow } from "./types.js";

const NOW = 1_793_320_000_000;
const SITE = { id: "00000000-0000-4000-8000-000000000001", url: "https://example-site.atlassian.net", name: "example-site" };

const CLAUDE_ENTRIES: McpInventoryEntry[] = (parseClaudeMcpStatus(CLAUDE_MCP_STATUS_SETTLED) ?? []).map((report) => ({ runtimeId: "claude", ...report, scannedAt: NOW }));

function row(key: string, overrides: Partial<TicketRow> = {}): TicketRow {
  return { key, id: key.replace(/\D/g, ""), title: `Title of ${key}`, statusCategory: "todo", statusLabel: "To Do", project: key.split("-")[0], updatedAt: NOW, url: `${SITE.url}/browse/${key}`, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class TestInventory implements IntegrationInventory {
  private listeners = new Set<(entries: McpInventoryEntry[]) => void>();
  scans = 0;
  started = 0;
  closed = 0;
  constructor(private list: McpInventoryEntry[] = []) {}
  entries() {
    return this.list.map((entry) => ({ ...entry }));
  }
  subscribe(listener: (entries: McpInventoryEntry[]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  scan() {
    this.scans += 1;
    return Promise.resolve([]);
  }
  noteInBand(runtimeId: string, servers: readonly { name: string; status: McpInventoryEntry["status"] }[]) {
    this.set(this.list.map((entry) => ({ ...entry, ...(entry.runtimeId === runtimeId ? { status: servers.find((server) => server.name === entry.name && server.status !== "pending")?.status ?? entry.status } : {}) })));
  }
  setStatus(runtimeId: string, name: string, status: McpInventoryEntry["status"], cwd?: string) {
    this.set(this.list.map((entry) => (entry.runtimeId === runtimeId && entry.name === name && entry.cwd === cwd ? { ...entry, status } : entry)));
  }
  start() {
    this.started += 1;
  }
  close() {
    this.closed += 1;
  }
  set(entries: McpInventoryEntry[]) {
    this.list = entries;
    for (const listener of this.listeners) listener(this.entries());
  }
}

class MemoryStore implements IntegrationsStore {
  saved: PersistedIntegrations | undefined;
  saves = 0;
  constructor(initial?: PersistedIntegrations) {
    this.saved = initial;
  }
  load() {
    return this.saved ? structuredClone(this.saved) : undefined;
  }
  save(state: PersistedIntegrations) {
    this.saves += 1;
    this.saved = structuredClone(state);
  }
}

function harness(options: { entries?: McpInventoryEntry[]; store?: MemoryStore; reader?: boolean } = {}) {
  let now = NOW;
  const inventory = new TestInventory(options.entries ?? CLAUDE_ENTRIES);
  const requests: IntegrationReadRequest[] = [];
  const pending: { request: IntegrationReadRequest; resolve: (result: IntegrationReadResult) => void }[] = [];
  const store = options.store ?? new MemoryStore();
  const service = new IntegrationService({
    inventory,
    store,
    now: () => now,
    ...(options.reader === false
      ? {}
      : {
          reader: {
            read(request) {
              requests.push(request);
              const { promise, resolve } = deferred<IntegrationReadResult>();
              pending.push({ request, resolve });
              return promise;
            },
          },
        }),
  });
  const snapshots: IntegrationsStateMessage[] = [];
  service.subscribe((message) => snapshots.push(message));
  return {
    service,
    inventory,
    store,
    requests,
    snapshots,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    /** Answers the oldest read still waiting. */
    answer(result: IntegrationReadResult) {
      const next = pending.shift();
      assert.ok(next, "no read is waiting");
      next.resolve(result);
    },
    jira() {
      const jira = service.getSnapshot().integrations.find((integration) => integration.id === "jira");
      assert.ok(jira);
      return jira;
    },
    query(query: QueryState["query"], param: string | null) {
      return this.jira().queries.find((state) => state.query === query && state.param === param);
    },
  };
}

test("the snapshot shows Jira through the claude.ai connector, with the other matches as alternatives", () => {
  const h = harness();
  const jira = h.jira();
  assert.deepEqual(jira.runtimes, [{ runtimeId: "claude", serverName: "claude.ai Atlassian", scope: "claudeai", status: "connected", authMode: "claudeai", alternatives: 2 }]);
  assert.equal(jira.fetchRuntime, "claude");
  assert.deepEqual(jira.prefs, { project: null });
  assert.deepEqual(jira.queries, []);
});

test("Jira is listed with no runtimes when no server matches, and follows the inventory", () => {
  const h = harness({ entries: [] });
  assert.deepEqual(h.jira().runtimes, []);
  assert.equal(h.jira().fetchRuntime, undefined);
  h.inventory.set(CLAUDE_ENTRIES);
  assert.equal(h.snapshots.at(-1)?.integrations[0].runtimes[0]?.serverName, "claude.ai Atlassian");
  assert.equal(h.store.saved?.inventory.length, CLAUDE_ENTRIES.length, "the inventory is saved on change");
});

test("only installed CLIs count once they are known; Codex wins the fetch when both are connected", () => {
  const codex: McpInventoryEntry = { runtimeId: "codex", name: "atlassian", scope: "user", transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, status: "connected", authMode: "oauth", scannedAt: NOW };
  const h = harness({ entries: [...CLAUDE_ENTRIES, codex] });
  assert.equal(h.jira().fetchRuntime, "codex");
  h.service.setInstalledRuntimes(["claude"]);
  assert.deepEqual(h.jira().runtimes.map((runtime) => runtime.runtimeId), ["claude"]);
  assert.equal(h.jira().fetchRuntime, "claude");
});

test("prefs: a project key is kept and saved, anything else refused", () => {
  const h = harness();
  assert.equal(h.service.setPrefs("jira", { project: "NGL" }), true);
  assert.deepEqual(h.jira().prefs, { project: "NGL" });
  assert.deepEqual(h.store.saved?.integrations.jira.prefs, { project: "NGL" });
  assert.equal(h.service.setPrefs("jira", { project: 'NGL" OR 1=1' }), false);
  assert.equal(h.service.setPrefs("linear", { project: null }), false);
  assert.deepEqual(h.jira().prefs, { project: "NGL" });
});

test("prefs, site and good reads come back from the store; a failed read leaves nothing new", async () => {
  const store = new MemoryStore();
  const first = harness({ store });
  first.service.setPrefs("jira", { project: "NGL" });
  const read = first.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  first.answer({ ok: true, runtimeId: "claude", site: SITE, items: [row("NGL-1")], nextPageToken: "page-2" });
  await read;
  const failed = first.service.refresh({ id: "jira", query: "ticket", param: "NGL-1", force: false });
  first.answer({ ok: false, status: "error", error: { kind: "network" } });
  await failed;

  const second = harness({ store });
  const jira = second.jira();
  assert.deepEqual(jira.prefs, { project: "NGL" });
  assert.deepEqual(jira.site, SITE);
  assert.equal(jira.queries.length, 1);
  const mine = second.query("mine", null);
  assert.equal(mine?.status, "ok");
  assert.equal(mine?.reading, false);
  assert.ok(mine?.query === "mine" && mine.items?.[0].key === "NGL-1" && mine.nextPageToken === "page-2");
});

test("opening the panel reads once when there is nothing, then serves the cache", async () => {
  const h = harness();
  const read = h.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  const joined = h.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  assert.equal(h.requests.length, 1, "a second ask joins the read in flight");
  const reading = h.query("mine", null);
  assert.equal(reading?.reading, true);
  assert.equal(reading?.readingSince, NOW);
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-1"), row("NGL-2", { statusCategory: "done" })] });
  assert.equal(await read, "read");
  assert.equal(await joined, "joined");
  const mine = h.query("mine", null);
  assert.ok(mine?.query === "mine");
  assert.deepEqual(mine.items?.map((item) => item.key), ["NGL-1"], "done tickets are never listed");
  assert.equal(mine.source, "open");
  assert.equal(mine.observedAt, NOW);
  h.advance(10 * 60_000);
  assert.equal(await h.service.refresh({ id: "jira", query: "mine", param: null, force: false }), "cached");
  assert.equal(h.requests.length, 1);
});

test("↻ is refused inside the floor, with refreshableAt in the snapshot, and reads past it", async () => {
  const h = harness();
  const read = h.service.refresh({ id: "jira", query: "mine", param: "NGL", force: true });
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-1")] });
  await read;
  assert.equal(h.query("mine", "NGL")?.refreshableAt, NOW + INTEGRATIONS_FORCE_FLOOR_MS);
  h.advance(INTEGRATIONS_FORCE_FLOOR_MS - 1);
  assert.equal(await h.service.refresh({ id: "jira", query: "mine", param: "NGL", force: true }), "refused");
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal(h.query("mine", "NGL")?.refreshableAt, undefined, "past the floor the field goes");
  const again = h.service.refresh({ id: "jira", query: "mine", param: "NGL", force: true });
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1], { integrationId: "jira", provider: "jira", query: "mine", param: "NGL" });
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-3")] });
  await again;
  assert.equal(h.query("mine", "NGL")?.source, "manual");
});

test("load more appends the next page; ↻ goes back to the first page alone", async () => {
  const h = harness();
  const first = h.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-1"), row("NGL-2")], nextPageToken: "t2" });
  await first;
  const more = h.service.loadMore({ id: "jira", param: null });
  assert.equal(h.requests.at(-1)?.pageToken, "t2");
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-2"), row("ABC-3")] });
  assert.equal(await more, "read");
  let mine = h.query("mine", null);
  assert.ok(mine?.query === "mine");
  assert.deepEqual(mine.items?.map((item) => item.key), ["NGL-1", "NGL-2", "ABC-3"]);
  assert.equal(mine.nextPageToken, undefined, "the last page has no token");
  assert.equal(mine.refreshableAt, NOW + INTEGRATIONS_FORCE_FLOOR_MS, "load more does not move the floor");
  assert.equal(await h.service.loadMore({ id: "jira", param: null }), "cached", "nothing more to load");

  h.advance(INTEGRATIONS_FORCE_FLOOR_MS);
  const refresh = h.service.refresh({ id: "jira", query: "mine", param: null, force: true });
  assert.equal(h.requests.at(-1)?.pageToken, undefined);
  h.answer({ ok: true, runtimeId: "claude", items: [row("NGL-9")], nextPageToken: "t2b" });
  await refresh;
  mine = h.query("mine", null);
  assert.ok(mine?.query === "mine");
  assert.deepEqual(mine.items?.map((item) => item.key), ["NGL-9"]);
  assert.equal(mine.nextPageToken, "t2b");
});

test("a failed read keeps the last good data and says why", async () => {
  const h = harness();
  const ok = h.service.refresh({ id: "jira", query: "ticket", param: "NGL-7", force: false });
  const detail = { ...row("NGL-7"), descriptionMd: "Body", comments: [] };
  h.answer({ ok: true, runtimeId: "claude", detail });
  await ok;
  h.advance(INTEGRATIONS_FORCE_FLOOR_MS);
  const failed = h.service.refresh({ id: "jira", query: "ticket", param: "NGL-7", force: true });
  h.answer({ ok: false, status: "needs_auth", error: { kind: "tool", message: "Tool getJiraIssue not found" } });
  await failed;
  const ticket = h.query("ticket", "NGL-7");
  assert.ok(ticket?.query === "ticket");
  assert.equal(ticket.status, "needs_auth");
  assert.equal(ticket.error?.kind, "tool");
  assert.deepEqual(ticket.detail, detail);
  assert.equal(ticket.observedAt, NOW, "the data shown is still the old read's");
});

test("a ticket screen revalidates on open past the floor; a list does not", async () => {
  const h = harness();
  const first = h.service.refresh({ id: "jira", query: "ticket", param: "NGL-7", force: false });
  h.answer({ ok: true, runtimeId: "claude", detail: { ...row("NGL-7"), comments: [] } });
  await first;
  assert.equal(await h.service.refresh({ id: "jira", query: "ticket", param: "NGL-7", force: false }), "cached");
  h.advance(INTEGRATIONS_FORCE_FLOOR_MS);
  const reopened = h.service.refresh({ id: "jira", query: "ticket", param: "NGL-7", force: false });
  assert.equal(h.requests.length, 2);
  h.answer({ ok: true, runtimeId: "claude", detail: { ...row("NGL-7", { title: "Renamed" }), comments: [] } });
  assert.equal(await reopened, "read");
  const ticket = h.query("ticket", "NGL-7");
  assert.ok(ticket?.query === "ticket" && ticket.detail?.title === "Renamed");
});

test("bad params, unknown integrations and a relay without a reader read nothing", async () => {
  const h = harness();
  assert.equal(await h.service.refresh({ id: "jira", query: "ticket", param: "not a key", force: true }), "unavailable");
  assert.equal(await h.service.refresh({ id: "jira", query: "mine", param: "ngl", force: true }), "unavailable");
  assert.equal(await h.service.refresh({ id: "linear", query: "mine", param: null, force: true }), "unavailable");
  assert.equal(await h.service.loadMore({ id: "jira", param: null }), "unavailable", "no list to continue");
  assert.equal(h.requests.length, 0);
  const none = harness({ reader: false });
  assert.equal(await none.service.refresh({ id: "jira", query: "mine", param: null, force: false }), "unavailable");
  assert.deepEqual(none.jira().queries, []);
});

test("the first client starts watching and rescans; a second one within a minute does not", async () => {
  const h = harness();
  const release = h.service.connectClient();
  await new Promise((done) => setImmediate(done));
  assert.equal(h.inventory.started, 1);
  assert.equal(h.inventory.scans, 1);
  release();
  release();
  assert.equal(h.service.connectedClients, 0);
  h.advance(30_000);
  h.service.connectClient()();
  await new Promise((done) => setImmediate(done));
  assert.equal(h.inventory.scans, 1);
  h.advance(30_000);
  h.service.connectClient();
  assert.equal(h.inventory.scans, 2);
  assert.equal(h.inventory.started, 1);
  h.service.close();
  assert.equal(h.inventory.closed, 1);
});

test("the force floor is overridable by env", () => {
  assert.equal(integrationsForceFloorFromEnv({}), INTEGRATIONS_FORCE_FLOOR_MS);
  assert.equal(integrationsForceFloorFromEnv({ [INTEGRATIONS_FORCE_FLOOR_ENV]: "0" }), 0);
  assert.equal(integrationsForceFloorFromEnv({ [INTEGRATIONS_FORCE_FLOOR_ENV]: "-5" }), INTEGRATIONS_FORCE_FLOOR_MS);
});

// --- the agent's own calls -----------------------------------------------------

test("identifyServer knows a Jira server by what it is, under the name the turn spells", () => {
  const { service } = harness();
  // `claude.ai Atlassian` as a Claude tool name spells it.
  assert.deepEqual(service.identifyServer("claude", "claude_ai_Atlassian"), { integrationId: "jira", provider: "jira" });
  assert.deepEqual(service.identifyServer("claude", "claude.ai Atlassian"), { integrationId: "jira", provider: "jira" });
  // Not another CLI's server, not another server, not a name alone.
  assert.equal(service.identifyServer("codex", "claude_ai_Atlassian"), undefined);
  assert.equal(service.identifyServer("claude", "sentry"), undefined);
  const named: McpInventoryEntry = { runtimeId: "claude", name: "my-jira", scope: "user", transport: { type: "stdio", command: "./run.sh" }, status: "connected", authMode: "none", scannedAt: NOW };
  const { service: byName } = harness({ entries: [named] });
  assert.equal(byName.identifyServer("claude", "my-jira"), undefined);
});

test("observeTickets caches a ticket screen read by the agent and refreshes only rows already listed", async () => {
  const h = harness();
  void h.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  h.answer({ ok: true, runtimeId: "claude", site: SITE, items: [row("NGL-1"), row("NGL-2")] });
  await new Promise((resolve) => setImmediate(resolve));
  h.advance(1000);

  h.service.observeTickets("jira", { detail: { ...row("NGL-1", { title: "Renamed by the agent" }), comments: [] } });
  const screen = h.query("ticket", "NGL-1");
  assert.equal(screen?.status, "ok");
  assert.equal(screen?.source, "turn");
  assert.equal(screen?.query === "ticket" ? screen.detail?.title : undefined, "Renamed by the agent");
  const mine = () => (h.query("mine", null) as Extract<QueryState, { query: "mine" }>).items?.map((item) => `${item.key}:${item.title}`);
  assert.deepEqual(mine(), ["NGL-1:Renamed by the agent", "NGL-2:Title of NGL-2"]);

  // A search the agent ran: a row it did not list before stays out.
  h.service.observeTickets("jira", { rows: [row("ABC-7"), row("NGL-2", { title: "Seen in a search" })] });
  assert.deepEqual(mine(), ["NGL-1:Renamed by the agent", "NGL-2:Seen in a search"]);
  assert.equal(h.query("ticket", "ABC-7"), undefined);
  assert.equal(h.service.ticketTitle("jira", "NGL-2"), "Seen in a search");

  // Done leaves the list; the ticket screen follows the row.
  h.service.observeTickets("jira", { rows: [row("NGL-1", { statusCategory: "done", statusLabel: "Done" })] });
  assert.deepEqual(mine(), ["NGL-2:Seen in a search"]);
  const done = h.query("ticket", "NGL-1");
  assert.equal(done?.query === "ticket" ? done.detail?.statusCategory : undefined, "done");
  assert.ok(h.store.saved?.integrations.jira.queries.some((query) => query.query === "ticket" && query.param === "NGL-1" && query.source === "turn"));
});

// --- the sessions' servers ---------------------------------------------------

test("a session's mcp_state lists only the servers recognized as an integration's, signed-in state first", () => {
  const h = harness();
  const state = h.service.sessionMcpState("claude", "/work/repo");
  assert.equal(state?.type, "mcp_state");
  assert.equal(state?.runtimeId, "claude");
  const names = state?.servers.map((server) => server.name) ?? [];
  assert.ok(names.includes("claude.ai Atlassian") && names.includes("claude.ai Atlassian MCP"));
  assert.ok(!names.includes("claude.ai Notion") && !names.includes("sentry"), "servers of no integration stay out");
  assert.deepEqual(
    state?.servers.find((server) => server.name === "claude.ai Atlassian MCP"),
    { name: "claude.ai Atlassian MCP", status: "needs_auth", integrationId: "jira", canLogin: true },
  );
  assert.equal(h.service.sessionMcpState("gemini", "/work/repo"), undefined, "an agent the integrations do not cover");
});

test("a failed call for want of a sign-in signs the server out, by the name its CLI spelled", () => {
  const h = harness();
  h.service.noteMcpFailure("claude", { server: "claude_ai_Atlassian", reason: "crashed" }, "/work");
  assert.equal(h.jira().runtimes[0]?.status, "connected", "only a sign-in failure counts");
  h.service.noteMcpFailure("claude", { server: "claude_ai_Atlassian", reason: "auth" }, "/work");
  assert.equal(h.inventory.entries().find((entry) => entry.name === "claude.ai Atlassian")?.status, "needs_auth");
  assert.equal(h.service.sessionMcpState("claude", "/work")?.servers.find((server) => server.name === "claude.ai Atlassian")?.status, "needs_auth");
  assert.equal(h.service.serverName("claude", "claude_ai_Atlassian"), "claude.ai Atlassian");
  assert.equal(h.service.serverName("claude", "nobody"), undefined);
});

test("a turn's word on its servers applies to the servers the inventory knows, and never makes it scan", () => {
  const h = harness();
  h.service.noteSessionMcp("claude", [{ name: "claude.ai Atlassian", status: "needs_auth" }, { name: "brand new", status: "needs_auth" }], "/work");
  assert.equal(h.inventory.entries().find((entry) => entry.name === "claude.ai Atlassian")?.status, "needs_auth");
  assert.equal(h.inventory.scans, 0);
});

test("a read that finds a server wants a sign-in signs it out in the inventory", async () => {
  const h = harness();
  const read = h.service.refresh({ id: "jira", query: "mine", param: null, force: false });
  const chosen = h.inventory.entries().find((entry) => entry.name === "claude.ai Atlassian");
  assert.ok(chosen);
  h.answer({ ok: false, status: "needs_auth", error: { kind: "tool", message: "the server needs a sign-in" }, needsAuth: [chosen] } as IntegrationReadResult);
  await read;
  assert.equal(h.jira().runtimes[0]?.status, "needs_auth");
  assert.equal(h.query("mine", null)?.status, "needs_auth");
});
