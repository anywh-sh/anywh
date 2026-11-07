// The integrations' state on disk, beside the profile's sessions file
// (`<profile>-integrations.json`): the MCP inventory, and per integration
// the tracker site, the person's choices and the last good read of every
// query. Nothing here expires — a read the relay could not repeat is still
// worth showing, marked by its age.
//
// The file is ours, but a hand edit or another format must not reach a
// client unchecked: every entry is re-checked field by field on load, and a
// file of another `version` is dropped whole (the next reads fill it again).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  TICKET_KEY_PATTERN,
  type IntegrationPrefs,
  type IntegrationReadSource,
  type IntegrationSite,
  type McpInventoryEntry,
  type McpToolInfo,
  type TicketComment,
  type TicketDetail,
  type TicketRow,
} from "./types.js";

export const INTEGRATIONS_FILE_VERSION = 1;

/** One query's last good read. */
export type PersistedQuery =
  | { query: "mine"; param: string | null; items: TicketRow[]; nextPageToken?: string; observedAt: number; source?: IntegrationReadSource }
  | { query: "ticket"; param: string; detail: TicketDetail; observedAt: number; source?: IntegrationReadSource };

export interface PersistedIntegration {
  site?: IntegrationSite;
  prefs: IntegrationPrefs;
  queries: PersistedQuery[];
}

export interface PersistedIntegrations {
  inventory: McpInventoryEntry[];
  /** By integration id (`"jira"`). */
  integrations: Record<string, PersistedIntegration>;
}

export interface IntegrationsStore {
  /** `undefined` when there is no file, or one this relay cannot read. */
  load(): PersistedIntegrations | undefined;
  save(state: PersistedIntegrations): void;
}

/** Next to the profile's sessions file, like the room and plan usage files. */
export function integrationsPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-integrations.json` : `${sessionsFile}-integrations.json`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const RUNTIMES = ["claude", "codex"];
const SCOPES = ["user", "local", "project", "plugin", "claudeai", "managed", "override"];
const STATUSES = ["connected", "needs_auth", "failed", "pending", "unknown"];
const AUTH_MODES = ["oauth", "claudeai", "none"];
const TRANSPORTS = ["stdio", "http", "sse", "claudeai-proxy"];
const CATEGORIES = ["todo", "doing", "done"];
const SOURCES = ["manual", "open", "turn"];
/** A project key as trackers write one (the part of `ENG-123` before the dash). */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every(isString) ? [...value] : undefined);

function restoreEntry(raw: unknown): McpInventoryEntry | undefined {
  if (!isRecord(raw) || !RUNTIMES.includes(raw.runtimeId as string) || !isString(raw.name) || !SCOPES.includes(raw.scope as string)) return undefined;
  if (!STATUSES.includes(raw.status as string) || !AUTH_MODES.includes(raw.authMode as string) || !isTime(raw.scannedAt)) return undefined;
  const transport = raw.transport;
  if (!isRecord(transport) || !TRANSPORTS.includes(transport.type as string)) return undefined;
  const entry: McpInventoryEntry = {
    runtimeId: raw.runtimeId as McpInventoryEntry["runtimeId"],
    name: raw.name,
    scope: raw.scope as McpInventoryEntry["scope"],
    transport: { type: transport.type as McpInventoryEntry["transport"]["type"] },
    status: raw.status as McpInventoryEntry["status"],
    authMode: raw.authMode as McpInventoryEntry["authMode"],
    scannedAt: raw.scannedAt,
  };
  if (isString(raw.cwd)) entry.cwd = raw.cwd;
  if (isString(transport.url)) entry.transport.url = transport.url;
  if (isString(transport.command)) entry.transport.command = transport.command;
  const args = stringList(transport.args);
  if (args) entry.transport.args = args;
  const envKeys = stringList(transport.envKeys);
  if (envKeys) entry.transport.envKeys = envKeys;
  if (isString(raw.serverInfoName)) entry.serverInfoName = raw.serverInfoName;
  if (Array.isArray(raw.tools)) {
    entry.tools = raw.tools
      .filter((tool): tool is Record<string, unknown> => isRecord(tool) && isString(tool.name))
      .map((tool): McpToolInfo => (typeof tool.readOnly === "boolean" ? { name: tool.name as string, readOnly: tool.readOnly } : { name: tool.name as string }));
  }
  if (isRecord(raw.claudeConfig)) entry.claudeConfig = raw.claudeConfig;
  return entry;
}

function restoreSite(raw: unknown): IntegrationSite | undefined {
  if (!isRecord(raw) || !isString(raw.id) || raw.id === "" || !isString(raw.url) || !isString(raw.name)) return undefined;
  return { id: raw.id, url: raw.url, name: raw.name };
}

function restorePrefs(raw: unknown): IntegrationPrefs {
  const project = isRecord(raw) && isString(raw.project) && PROJECT_KEY_PATTERN.test(raw.project) ? raw.project : null;
  return { project };
}

export function restoreTicketRow(raw: unknown): TicketRow | undefined {
  if (!isRecord(raw) || !isString(raw.key) || !TICKET_KEY_PATTERN.test(raw.key) || !isString(raw.id) || !isString(raw.title)) return undefined;
  if (!CATEGORIES.includes(raw.statusCategory as string) || !isString(raw.statusLabel) || !isString(raw.project) || !isTime(raw.updatedAt) || !isString(raw.url)) return undefined;
  const row: TicketRow = {
    key: raw.key,
    id: raw.id,
    title: raw.title,
    statusCategory: raw.statusCategory as TicketRow["statusCategory"],
    statusLabel: raw.statusLabel,
    project: raw.project,
    updatedAt: raw.updatedAt,
    url: raw.url,
  };
  if (isString(raw.priority)) row.priority = raw.priority;
  return row;
}

function restoreComment(raw: unknown): TicketComment | undefined {
  if (!isRecord(raw) || !isString(raw.author) || !isTime(raw.createdAt) || !isString(raw.bodyMd)) return undefined;
  return { author: raw.author, createdAt: raw.createdAt, bodyMd: raw.bodyMd };
}

function restoreDetail(raw: unknown): TicketDetail | undefined {
  const row = restoreTicketRow(raw);
  if (!row || !isRecord(raw) || !Array.isArray(raw.comments)) return undefined;
  const detail: TicketDetail = { ...row, comments: raw.comments.map(restoreComment).filter((comment): comment is TicketComment => comment !== undefined) };
  if (isString(raw.descriptionMd)) detail.descriptionMd = raw.descriptionMd;
  return detail;
}

function restoreQuery(raw: unknown): PersistedQuery | undefined {
  if (!isRecord(raw) || !isTime(raw.observedAt)) return undefined;
  const source = SOURCES.includes(raw.source as string) ? (raw.source as IntegrationReadSource) : undefined;
  if (raw.query === "mine") {
    if (!(raw.param === null || (isString(raw.param) && PROJECT_KEY_PATTERN.test(raw.param))) || !Array.isArray(raw.items)) return undefined;
    const items = raw.items.map(restoreTicketRow).filter((row): row is TicketRow => row !== undefined);
    return {
      query: "mine",
      param: raw.param,
      items,
      ...(isString(raw.nextPageToken) && raw.nextPageToken !== "" ? { nextPageToken: raw.nextPageToken } : {}),
      observedAt: raw.observedAt,
      ...(source ? { source } : {}),
    };
  }
  if (raw.query === "ticket" && isString(raw.param) && TICKET_KEY_PATTERN.test(raw.param)) {
    const detail = restoreDetail(raw.detail);
    if (!detail) return undefined;
    return { query: "ticket", param: raw.param, detail, observedAt: raw.observedAt, ...(source ? { source } : {}) };
  }
  return undefined;
}

function restoreIntegration(raw: unknown): PersistedIntegration | undefined {
  if (!isRecord(raw)) return undefined;
  const site = restoreSite(raw.site);
  const queries = Array.isArray(raw.queries) ? raw.queries.map(restoreQuery).filter((query): query is PersistedQuery => query !== undefined) : [];
  return { ...(site ? { site } : {}), prefs: restorePrefs(raw.prefs), queries };
}

/** The file's text as this relay reads it; `undefined` for another version
 * or something that is not this file at all. */
export function parseIntegrationsFile(text: string): PersistedIntegrations | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== INTEGRATIONS_FILE_VERSION) return undefined;
  const inventory = Array.isArray(parsed.inventory) ? parsed.inventory.map(restoreEntry).filter((entry): entry is McpInventoryEntry => entry !== undefined) : [];
  const integrations: Record<string, PersistedIntegration> = {};
  if (isRecord(parsed.integrations)) {
    for (const [id, raw] of Object.entries(parsed.integrations)) {
      const restored = restoreIntegration(raw);
      if (restored) integrations[id] = restored;
    }
  }
  return { inventory, integrations };
}

export function createFileIntegrationsStore(path: string): IntegrationsStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      return parseIntegrationsFile(text);
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: INTEGRATIONS_FILE_VERSION, ...state }), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
