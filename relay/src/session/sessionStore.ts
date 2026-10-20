import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ContextBreakdown } from "../context/breakdown.js";
import type { ChoiceQuestion } from "../bridges/mcpBridge.js";
import { isRoomMembership, type RoomMembership } from "./room.js";

// Session name -> { session_id, cwd/lock } mapping, persisted to disk per
// profile — without this, GET /sessions, continuity via --resume, and
// (since the working directory feature) each session's working folder
// depended only on memory and disappeared on every relay restart.
export interface SessionCwdState {
  cwd: string;
  /** Locks after the first turn — Claude Code's session_id gets tied to the
   * cwd used at spawn (confirmed by inspecting
   * ~/.claude/projects/<sanitized-cwd>/), so changing the folder of a
   * session with history would break the subsequent --resume. See
   * SharedSession.runTurn, which decides the exact moment of the lock. */
  locked: boolean;
}

/** Opaque permission-mode id — no fixed union anymore: the real vocabulary is
 * whatever the session's own def declares (`PermissionPolicy.modesFor(platform)`,
 * `runtimes/types.ts`), which differs per agent AND per platform (Codex's
 * `workspace-write` doesn't exist on win32). Claude's four values are one
 * def's answer, not this file's business — same reasoning `ModelChoice`
 * below already uses. Validation lives where the def is in scope
 * (`SharedSession`, via `session/permissionModes.ts`), not here and not in
 * the wire guard (`protocol/guards.ts`). */
export type PermissionMode = string;

/** Opaque `claude --model` value — no fixed union anymore: the real catalog
 * is fetched from the CLI itself (`probes/modelCatalog.ts`) instead
 * of curated by hand, so it can include aliases we haven't special-cased
 * (`sonnet[1m]`, `opusplan`, a full model ID, ...) without a relay change. */
export type ModelChoice = string;

/** Context usage of a session's most recent turn — see ClaudeSession (which
 * extracts this from the `claude -p` `result` event) and the context window
 * indicator plan. `contextWindowSize` comes straight from the CLI
 * (`modelUsage[model].contextWindow`), not from a static table of ours —
 * that way it stays correct for accounts with extended context (1M) without
 * needing to know about that in advance. */
export interface ContextUsage {
  /** Model resolved for that turn (e.g. "claude-sonnet-5"). */
  model: string;
  contextWindowSize: number;
  /** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   * from `result.usage` — same formula the official Claude Code docs use
   * for the statusline's `used_percentage` (excludes `output_tokens` on
   * purpose). */
  usedTokens: number;
  /** The conversation's first response's own `usedTokens` — system prompt +
   * tools + MCP + skills/memory + the first message, all already paid for
   * before anything else happened. Optional: absent for a record written
   * before this field existed, and never backfilled for a session that was
   * already mid-conversation when it shipped (there's no way to learn a
   * conversation's first response after the fact). Set at most once per
   * conversation (`ContextAttributor`'s `baseline`) — a `/clear` or editing
   * back to the first message starts a new one and gets its own. */
  baselineTokens?: number;
  /** The def's own estimate of what its baseline is made of (`context/
   * breakdown.ts`), cached here so reopening the popover after the first
   * request is free. Absent until a client sends `request_context_breakdown`
   * at least once, and again after `/clear` (a new conversation gets a new
   * `baselineTokens`, so any cached breakdown of the old one no longer
   * applies — see SharedSession's own reset of this field). */
  breakdown?: ContextBreakdown;
}

/** No fixed union: this file doesn't know the full set of agent ids
 * (`runtimes/registry.ts` does), and hardcoding one here would make adding
 * a def also require an edit to session persistence. `"claude"` is used as
 * the literal default below (`DEFAULT_AGENT_ID`) instead of importing
 * `claudeRuntimeDef.identity.id` from `runtimes/defs/claude/` — session
 * persistence stays the one describing its own default id, rather than a def
 * (which owns its own `PermissionMode`/`ModelChoice` vocabulary, not the
 * other way around). */
export type AgentId = string;

const DEFAULT_AGENT_ID: AgentId = "claude";

export interface SessionEntry {
  /** Which agent def owns this session — every session today, since no
   * runtime picks a different one yet (see `getAgentId`). Determines which
   * key `sessionId`/`permissionMode`/`model` read/write below. */
  agentId: AgentId;
  /** Keyed by `agentId` — a session's continuity with one agent is
   * independent of any other agent's, so switching agents (once possible)
   * can never clobber either one's `--resume` value. A record written
   * before this existed is migrated so its one value lands under
   * `DEFAULT_AGENT_ID`'s key (see `load()`). */
  sessionId: Record<AgentId, string | null>;
  /** `null` until the title is inferred from the first prompt (or set by a
   * manual rename) — while `null`, the session exists (cwd/lock may already
   * be in use) but doesn't show up in `listTitled()`/`GET /sessions`, which
   * is what keeps the sidebar blank until then. See
   * SessionManager.createSession (trigger) and titleGenerator.ts
   * (generation). */
  title: string | null;
  cwd: SessionCwdState;
  /** Timestamp (epoch ms) of the last turn sent — this is what orders
   * `listTitled()`. Updated on every turn, not just the first (see
   * `touch`), so reopening an old session and chatting with it moves it
   * back to the top of the sidebar. Never `null`: creation/migration
   * already seeds it with the current timestamp, so a freshly created
   * session still sorts in (no need for "never interacted with" as a
   * special case). */
  lastActiveAt: number;
  /** Optional to tolerate records written before this feature existed —
   * read as the caller's own `fallbackModeId` (see `getPermissionMode`),
   * which for Claude is `"bypassPermissions"`, the hardcoded behavior
   * everyone already had before a selectable mode existed. Unlike `cwd`, it
   * doesn't lock after the first turn — the mode can change at any point in
   * the conversation. Keyed by `agentId`, same reasoning as `sessionId`
   * above. */
  permissionMode?: Record<AgentId, PermissionMode>;
  /** Optional: `undefined` (never chosen via `/model`) means "don't pass
   * `--model` on spawn", same as the behavior that always existed before
   * this feature — unlike `permissionMode`, there's no hardcoded fallback
   * value, because "let the CLI decide its own default" already IS the
   * default behavior. Same "doesn't lock after the first turn" rule as
   * `permissionMode`, and the same per-`agentId` keying as `sessionId`. */
  model?: Record<AgentId, ModelChoice>;
  /** The explicit reasoning-effort pick, per `agentId`. Absent means none
   * (the model's own default). Optional, so records written before this
   * existed need no migration. Never locks, unlike the model. */
  effort?: Record<AgentId, string>;
  /** Optional for the same reason as `permissionMode`: tolerates records
   * written before this feature existed. Never rebuilt from Claude Code's
   * `.jsonl` on a restart — the `result` event (the only source of the real
   * per-model limit) only exists in `claude -p`'s live stdout, it's never
   * persisted in the transcript. That's why it needs to be recorded here on
   * every turn, otherwise it disappears for the client until the next turn
   * runs. Keyed by `agentId`, same reasoning as `sessionId`/`permissionMode`/
   * `model` above — a record written before this was per-agent is migrated
   * so its one value lands under `DEFAULT_AGENT_ID`'s key (see `load()`). */
  contextUsage?: Record<AgentId, ContextUsage>;
  /** Text typed into the composer but not yet sent, kept so it survives an
   * app crash/restart — see the prompt-draft feature. Optional for the same
   * reason as `permissionMode`/`model`: tolerates records written before
   * this feature existed (read as `""` via `getDraft`). */
  draft?: string;
  /** Next-message suggestion generated after the last turn, kept so it
   * survives a relay restart — see the prompt-draft feature's `draft` above
   * and SharedSession's `suggestion` for why this stopped being in-memory
   * only. `null` means "generated, but cleared" (a new turn/`/clear`/edit
   * happened since); `undefined`/absent means "never had one" — both read
   * as `null` via `getSuggestion`, the distinction doesn't matter to a
   * reconnecting client either way. */
  suggestion?: string | null;
  /** The deferred `present_choice`/plan-marker question still waiting for a
   * human, kept so it survives a relay restart — it can sit unanswered for
   * days. Optional for the same reason as `permissionMode`/`draft`: records
   * written before this feature existed simply have none (read as
   * `undefined` via `getPendingChoice`). `promptId` is stored too, so a
   * reconnecting device sees the same prompt it saw before the restart. */
  pendingChoice?: PersistedChoice;
  /** Membership in a room (see `room.ts`). Absent on every session that is
   * not an agent of a room, which is every session written before rooms
   * existed: they need no migration and behave exactly as before. */
  room?: RoomMembership;
}

/** A question as the relay publishes it (`choice_prompt`). */
export interface ChoicePrompt {
  promptId: string;
  questions: ChoiceQuestion[];
  /** Epoch ms when the question was asked; absent for a question persisted
   * before the field existed (the client treats absence as "unknown"). */
  askedAt?: number;
}

/** The deferred question as stored on disk. The single definition of this
 * shape: `ChoiceMachine` and `SharedSession` import it from here (type-only),
 * so the store never has to import from `session/choiceMachine.ts`. */
export interface PersistedChoice {
  promptId: string;
  questions: ChoiceQuestion[];
  /** Set once when the question is created and never changed. Left
   * undefined for legacy records and for a malformed value (`load()` drops
   * just that field). */
  askedAt?: number;
}

/** Runtime check for what `load()` reads back: this field is the first one
 * fed straight to the WS broadcast code, so a hand-edited, truncated or
 * future-schema file must not be able to reach it malformed. */
function isPersistedChoice(value: unknown): value is PersistedChoice {
  if (!value || typeof value !== "object") return false;
  // `askedAt` is deliberately not checked here: a bad timestamp must not cost
  // the user their question. `load()` clears just that field instead.
  const { promptId, questions } = value as { promptId?: unknown; questions?: unknown };
  if (typeof promptId !== "string" || promptId === "") return false;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  const optionalString = (v: unknown) => v === undefined || typeof v === "string";
  return questions.every((q) => {
    if (!q || typeof q !== "object") return false;
    const { question, options, header, multiSelect, approval } = q as Record<string, unknown>;
    if (typeof question !== "string" || !optionalString(header)) return false;
    if (multiSelect !== undefined && typeof multiSelect !== "boolean") return false;
    if (approval !== undefined && (!approval || typeof approval !== "object")) return false;
    if (!Array.isArray(options)) return false;
    return options.every((o) => {
      if (!o || typeof o !== "object") return false;
      const { label, description, id } = o as Record<string, unknown>;
      return typeof label === "string" && optionalString(description) && optionalString(id);
    });
  });
}

export type SessionRecord = Record<string, SessionEntry>;

/** One row of `GET /sessions` — the already-titled sessions the sidebar
 * lists, newest interaction first. `lastActiveAt` travels with the row
 * because the client groups the list by recency ("today" / "yesterday" /
 * "7 days") and has no other source for a per-session timestamp. */
export interface TitledSession {
  id: string;
  title: string;
  lastActiveAt: number;
}

/** Shape prior to this change: id -> { session_id, cwd/lock }, without
 * `title` — the id itself was already the "name" shown in the UI. Used only
 * to migrate files written before the title/rename feature. */
type PreTitleSessionRecord = Record<string, { sessionId: string | null; cwd: SessionCwdState }>;

function isPreTitleRecord(value: object): value is PreTitleSessionRecord {
  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      !("title" in entry) &&
      "sessionId" in entry &&
      "cwd" in entry,
  );
}

/** Shape prior to this change: already has `title`, but not `lastActiveAt`
 * — files written between the title/rename feature and the last-interaction
 * ordering feature. */
type PreActivitySessionRecord = Record<string, { sessionId: string | null; title: string | null; cwd: SessionCwdState }>;

function isPreActivityRecord(value: object): value is PreActivitySessionRecord {
  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "title" in entry &&
      !("lastActiveAt" in entry),
  );
}

/** Shape prior to this change: name -> session_id (or null). Used only to
 * detect and migrate session files that already exist in production. */
type LegacySessionRecord = Record<string, string | null>;

function isLegacyRecord(value: object): value is LegacySessionRecord {
  return Object.values(value).every((entry) => typeof entry === "string" || entry === null);
}

/** Shape prior to this change: already has `lastActiveAt`, but `sessionId`/
 * `permissionMode`/`model` are flat — one agent (implicitly Claude) per
 * session, not keyed by `agentId`. Every session file in production today
 * is this shape, `PreTitleSessionRecord`, or `PreActivitySessionRecord`. */
type PreAgentSessionRecord = Record<
  string,
  {
    sessionId: string | null;
    title: string | null;
    cwd: SessionCwdState;
    lastActiveAt: number;
    permissionMode?: PermissionMode;
    model?: ModelChoice;
    contextUsage?: ContextUsage;
    draft?: string;
    suggestion?: string | null;
  }
>;

function isPreAgentRecord(value: object): value is PreAgentSessionRecord {
  return Object.values(value).every(
    (entry) => typeof entry === "object" && entry !== null && "lastActiveAt" in entry && !("agentId" in entry),
  );
}

/** Shape prior to this change: `agentId`/`sessionId`/`permissionMode`/`model`
 * are already per-agent, but `contextUsage` is still flat — one session, one
 * `ContextUsage`, not keyed by `agentId`. Every session file written between
 * the agent-keying migration above and this one is this shape. */
type PreContextUsageAgentRecord = Record<string, Omit<SessionEntry, "contextUsage"> & { contextUsage?: ContextUsage }>;

/** Distinguishes the old flat `ContextUsage` from the new `Record<AgentId,
 * ContextUsage>` by checking for `contextWindowSize` directly on
 * `contextUsage` — only the flat shape has it at that level; the new shape's
 * own keys are agent ids (`"claude"`, `"codex"`, ...), and no agent id is
 * ever literally `"contextWindowSize"`. `some`, not `every`: `contextUsage`
 * is optional per session, so most entries may not have one at all — the
 * check only needs one entry in the old shape to know the whole file is. */
function hasFlatContextUsage(value: object): value is PreContextUsageAgentRecord {
  return Object.values(value).some((entry) => {
    if (typeof entry !== "object" || entry === null || !("contextUsage" in entry)) return false;
    const usage = (entry as { contextUsage?: unknown }).contextUsage;
    return typeof usage === "object" && usage !== null && "contextWindowSize" in usage;
  });
}

export class SessionStore {
  private records: SessionRecord;
  private migrated = false;
  /** Whether the records came from a file that exists and parsed. Anything
   * that removes things the store does not list (the rooms' agents in the
   * host) only trusts a store loaded this way. */
  private loadedFromFile = false;

  constructor(
    private readonly filePath: string,
    private readonly defaultCwd: string,
  ) {
    this.records = this.load();
    if (this.migrated) this.persist();
  }

  private load(): SessionRecord {
    const records = this.loadAndMigrate();
    for (const entry of Object.values(records)) {
      if (entry && typeof entry === "object" && entry.pendingChoice !== undefined && !isPersistedChoice(entry.pendingChoice)) {
        // Drop the bad record instead of crashing or adopting it; rewrite so
        // it doesn't come back on the next boot.
        delete entry.pendingChoice;
        this.migrated = true;
      } else if (entry?.pendingChoice && "askedAt" in entry.pendingChoice) {
        const { askedAt } = entry.pendingChoice as { askedAt: unknown };
        // Keep the question; only a non-negative finite number survives as the
        // timestamp (decimals truncated), anything else leaves it undefined.
        if (typeof askedAt === "number" && Number.isFinite(askedAt) && askedAt >= 0) {
          if (!Number.isInteger(askedAt)) {
            entry.pendingChoice.askedAt = Math.trunc(askedAt);
            this.migrated = true;
          }
        } else {
          delete entry.pendingChoice.askedAt;
          this.migrated = true;
        }
      }
      if (entry && typeof entry === "object" && entry.room !== undefined && !isRoomMembership(entry.room)) {
        // Same treatment as a bad pendingChoice: the session survives, as an
        // ordinary one, and the bad record is not written back.
        delete entry.room;
        this.migrated = true;
      }
    }
    return records;
  }

  private loadAndMigrate(): SessionRecord {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch {
      // Missing the first time: start with an empty mapping.
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Corrupted — never crash the relay because of this, start empty, and
      // keep the file aside instead of overwriting it on the next write.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // best effort
      }
      return {};
    }
    this.loadedFromFile = true;

    // A single timestamp for the whole migration batch (not `Date.now()`
    // per entry): keeps existing sessions tied in the `lastActiveAt`
    // ordering, and V8's stable `Array.sort` preserves the original
    // (insertion) order among ties — doesn't shuffle the existing list.
    const migrationNow = Date.now();

    if (isLegacyRecord(parsed)) {
      this.migrated = true;
      const migrated: SessionRecord = {};
      for (const [name, sessionId] of Object.entries(parsed)) {
        // A session that already had a real session_id already has history
        // recorded under the implicit cwd from back then (homeOverride ??
        // homedir()) — treat it as already locked, to avoid risking
        // breaking its --resume. Old name becomes both id AND initial
        // title: an already-existing session doesn't need (and shouldn't)
        // generate a new title, it already had a useful name.
        migrated[name] = {
          agentId: DEFAULT_AGENT_ID,
          sessionId: { [DEFAULT_AGENT_ID]: sessionId },
          title: name,
          cwd: { cwd: this.defaultCwd, locked: sessionId !== null },
          lastActiveAt: migrationNow,
        };
      }
      return migrated;
    }

    if (isPreTitleRecord(parsed)) {
      this.migrated = true;
      const migrated: SessionRecord = {};
      for (const [id, entry] of Object.entries(parsed)) {
        migrated[id] = { agentId: DEFAULT_AGENT_ID, sessionId: { [DEFAULT_AGENT_ID]: entry.sessionId }, cwd: entry.cwd, title: id, lastActiveAt: migrationNow };
      }
      return migrated;
    }

    if (isPreActivityRecord(parsed)) {
      this.migrated = true;
      const migrated: SessionRecord = {};
      for (const [id, entry] of Object.entries(parsed)) {
        migrated[id] = { agentId: DEFAULT_AGENT_ID, sessionId: { [DEFAULT_AGENT_ID]: entry.sessionId }, title: entry.title, cwd: entry.cwd, lastActiveAt: migrationNow };
      }
      return migrated;
    }

    if (isPreAgentRecord(parsed)) {
      this.migrated = true;
      const migrated: SessionRecord = {};
      for (const [id, entry] of Object.entries(parsed)) {
        const { sessionId, permissionMode, model, contextUsage, ...rest } = entry;
        migrated[id] = {
          ...rest,
          agentId: DEFAULT_AGENT_ID,
          sessionId: { [DEFAULT_AGENT_ID]: sessionId },
          ...(permissionMode !== undefined ? { permissionMode: { [DEFAULT_AGENT_ID]: permissionMode } } : {}),
          ...(model !== undefined ? { model: { [DEFAULT_AGENT_ID]: model } } : {}),
          ...(contextUsage !== undefined ? { contextUsage: { [DEFAULT_AGENT_ID]: contextUsage } } : {}),
        };
      }
      return migrated;
    }

    if (hasFlatContextUsage(parsed)) {
      this.migrated = true;
      const migrated: SessionRecord = {};
      for (const [id, entry] of Object.entries(parsed)) {
        const { contextUsage, agentId, ...rest } = entry;
        migrated[id] = {
          ...rest,
          agentId,
          ...(contextUsage !== undefined ? { contextUsage: { [agentId]: contextUsage } } : {}),
        };
      }
      return migrated;
    }

    return parsed as SessionRecord;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  /** See `loadedFromFile`. */
  get loadedOk(): boolean {
    return this.loadedFromFile;
  }

  /** Whether any record exists for `id` (with or without a room). */
  has(id: string): boolean {
    return id in this.records;
  }

  /** All known ids, titled or not — used only to materialize the
   * `SharedSession` instances in memory at boot (SessionManager), which
   * need to exist even for a session without a title yet (cwd/lock/session_id
   * may already be in use). */
  listIds(): string[] {
    return Object.keys(this.records);
  }

  /** Only the already-titled sessions — this is what `GET /sessions`
   * exposes, which keeps the sidebar blank until the first prompt (or a
   * manual rename) gives the session a title. Sorted by last interaction
   * (most recent first) — reopening an old session and chatting with it
   * moves it to the top. */
  listTitled(): TitledSession[] {
    return Object.entries(this.records)
      // A room's workers are reached through the room, never listed on their
      // own — unless their room is gone, so they can still be found and removed.
      .filter((entry): entry is [string, SessionEntry & { title: string }] => entry[1].title !== null && !this.isHiddenWorker(entry[0]))
      .sort(([, a], [, b]) => b.lastActiveAt - a.lastActiveAt)
      .map(([id, entry]) => ({ id, title: entry.title, lastActiveAt: entry.lastActiveAt }));
  }

  /** Last-turn timestamp of a single session, for the callers that report a
   * list change one entry at a time (`SessionManager`'s `onListChanged`)
   * instead of re-reading the whole list. `undefined` for an id that was
   * never recorded. */
  getLastActiveAt(id: string): number | undefined {
    return this.records[id]?.lastActiveAt;
  }

  getSessionId(id: string, agentId: AgentId): string | undefined {
    return this.records[id]?.sessionId[agentId] ?? undefined;
  }

  getTitle(id: string): string | null {
    return this.records[id]?.title ?? null;
  }

  /** Idempotent — guarantees the id already exists (without a title yet)
   * even before the first turn finishes (and therefore before we have a
   * real session_id for it). */
  recordId(id: string): void {
    if (id in this.records) return;
    this.records[id] = { agentId: DEFAULT_AGENT_ID, sessionId: {}, title: null, cwd: { cwd: this.defaultCwd, locked: false }, lastActiveAt: Date.now() };
    this.persist();
  }

  /** Which agent def owns this session — `DEFAULT_AGENT_ID` for an id that
   * doesn't exist yet or predates this field, same fallback shape as every
   * other per-session getter here. */
  getAgentId(id: string): AgentId {
    return this.records[id]?.agentId ?? DEFAULT_AGENT_ID;
  }

  /** The write side `getAgentId` never had — until now every session was
   * permanently `DEFAULT_AGENT_ID`, since nothing ever called this.
   * `sessionId`/`permissionMode`/`model` are already keyed by `agentId`
   * (see `SessionEntry`'s own comments), which is exactly what makes
   * switching non-destructive: each agent keeps its own thread id, mode and
   * model, and switching back resumes where it left off. */
  setAgentId(id: string, agentId: AgentId): void {
    this.ensureEntry(id);
    this.records[id].agentId = agentId;
    this.persist();
  }

  /** Called on every turn sent (not just the first) — this is what makes an
   * old session move back to the top of the sidebar when used again. */
  touch(id: string): void {
    this.ensureEntry(id);
    this.records[id].lastActiveAt = Date.now();
    this.persist();
  }

  /** `true` if the session existed (and was removed); `false` if it already
   * didn't exist. Only removes it from anywh's control — doesn't touch the
   * transcript that Claude Code already maintains on its own in
   * `~/.claude/projects/`. */
  deleteEntry(id: string): boolean {
    if (!(id in this.records)) return false;
    delete this.records[id];
    this.persist();
    return true;
  }

  /** Used both to record the title inferred from the first prompt and for a
   * manual rename — in both cases it's just "the title now is this one". */
  setTitle(id: string, title: string): void {
    this.ensureEntry(id);
    this.records[id].title = title;
    this.persist();
  }

  recordSessionId(id: string, agentId: AgentId, sessionId: string): void {
    this.ensureEntry(id);
    this.records[id].sessionId[agentId] = sessionId;
    this.persist();
  }

  /** `/clear` — drops the recorded continuity, otherwise a relay
   * restart would go back to `--resume`ing the conversation the user
   * already cleared. */
  clearSessionId(id: string, agentId: AgentId): void {
    this.ensureEntry(id);
    this.records[id].sessionId[agentId] = null;
    this.persist();
  }

  /** `/clear` — drops the title along with the session_id/history it
   * described, so the next real prompt gets a fresh one instead of leaving
   * the old conversation's title stuck on a now-unrelated conversation. */
  clearTitle(id: string): void {
    this.ensureEntry(id);
    this.records[id].title = null;
    this.persist();
  }

  getCwdState(id: string): SessionCwdState {
    return this.records[id]?.cwd ?? { cwd: this.defaultCwd, locked: false };
  }

  setCwd(id: string, cwd: string): void {
    this.ensureEntry(id);
    this.records[id].cwd.cwd = cwd;
    this.persist();
  }

  lockCwd(id: string): void {
    this.ensureEntry(id);
    this.records[id].cwd.locked = true;
    this.persist();
  }

  /** `/clear` (see `SharedSession.clearConversation`) — counterpart to
   * `lockCwd`, otherwise a relay restart would go back to loading the
   * session as locked even after it was unlocked. */
  unlockCwd(id: string): void {
    this.ensureEntry(id);
    this.records[id].cwd.locked = false;
    this.persist();
  }

  /** `fallbackModeId` is the caller's (`SessionManager`'s) job — it already
   * resolved the session's def by the time it calls this, and the fallback
   * is that def's own `permissions.defaultModeId`, not a value this file
   * could know on its own (Claude's happens to be `"bypassPermissions"`,
   * Codex's `"workspace-write"`). */
  getPermissionMode(id: string, agentId: AgentId, fallbackModeId: string): PermissionMode {
    return this.records[id]?.permissionMode?.[agentId] ?? fallbackModeId;
  }

  setPermissionMode(id: string, agentId: AgentId, mode: PermissionMode): void {
    this.ensureEntry(id);
    this.records[id].permissionMode ??= {};
    this.records[id].permissionMode[agentId] = mode;
    this.persist();
  }

  getModel(id: string, agentId: AgentId): ModelChoice | undefined {
    return this.records[id]?.model?.[agentId];
  }

  setModel(id: string, agentId: AgentId, model: ModelChoice): void {
    this.ensureEntry(id);
    this.records[id].model ??= {};
    this.records[id].model[agentId] = model;
    this.persist();
  }

  getEffort(id: string, agentId: AgentId): string | undefined {
    return this.records[id]?.effort?.[agentId];
  }

  /** `null` clears the pick (back to the model's default). */
  setEffort(id: string, agentId: AgentId, effort: string | null): void {
    this.ensureEntry(id);
    if (effort === null) {
      if (this.records[id].effort?.[agentId] === undefined) return;
      delete this.records[id].effort[agentId];
    } else {
      this.records[id].effort ??= {};
      this.records[id].effort[agentId] = effort;
    }
    this.persist();
  }

  getContextUsage(id: string, agentId: AgentId): ContextUsage | undefined {
    return this.records[id]?.contextUsage?.[agentId];
  }

  setContextUsage(id: string, agentId: AgentId, usage: ContextUsage): void {
    this.ensureEntry(id);
    this.records[id].contextUsage ??= {};
    this.records[id].contextUsage[agentId] = usage;
    this.persist();
  }

  getDraft(id: string): string {
    return this.records[id]?.draft ?? "";
  }

  /** No-op on an unchanged value — unlike the other setters, this one is
   * expected to be called frequently (debounced per keystroke on the client
   * side), and `persist()` is a synchronous full-file `writeFileSync` with
   * no batching of its own. */
  setDraft(id: string, text: string): void {
    this.ensureEntry(id);
    if (this.records[id].draft === text) return;
    this.records[id].draft = text;
    this.persist();
  }

  getSuggestion(id: string): string | null {
    return this.records[id]?.suggestion ?? null;
  }

  setSuggestion(id: string, text: string | null): void {
    this.ensureEntry(id);
    if (this.records[id].suggestion === text) return;
    this.records[id].suggestion = text;
    this.persist();
  }

  getPendingChoice(id: string): PersistedChoice | undefined {
    const stored = this.records[id]?.pendingChoice;
    return stored === undefined ? undefined : structuredClone(stored);
  }

  /** `undefined` clears it. No-op when there's nothing to clear, so
   * discarding a never-asked question doesn't create a record or rewrite
   * the file. */
  setPendingChoice(id: string, choice: PersistedChoice | undefined): void {
    if (choice === undefined) {
      if (this.records[id]?.pendingChoice === undefined) return;
      delete this.records[id].pendingChoice;
    } else {
      this.ensureEntry(id);
      // Copy: the caller (ChoiceMachine) keeps its own reference.
      this.records[id].pendingChoice = structuredClone(choice);
    }
    this.persist();
  }

  /** A worker of a room whose principal exists: reached through the room. */
  isHiddenWorker(id: string): boolean {
    const room = this.records[id]?.room;
    return room?.role === "worker" && this.records[room.roomId]?.room?.role === "principal";
  }

  getRoom(id: string): RoomMembership | undefined {
    const stored = this.records[id]?.room;
    return stored === undefined ? undefined : structuredClone(stored);
  }

  /** `undefined` takes the session out of its room. */
  setRoom(id: string, room: RoomMembership | undefined): void {
    if (room === undefined) {
      if (this.records[id]?.room === undefined) return;
      delete this.records[id].room;
    } else {
      this.ensureEntry(id);
      this.records[id].room = structuredClone(room);
    }
    this.persist();
  }

  /** Every session of room `roomId` (its principal included), as id and
   * membership. */
  listRoomMembers(roomId: string): { id: string; room: RoomMembership }[] {
    return Object.entries(this.records)
      .filter(([, entry]) => entry.room?.roomId === roomId)
      .map(([id, entry]) => ({ id, room: structuredClone(entry.room!) }));
  }

  private ensureEntry(id: string): void {
    if (!(id in this.records)) {
      this.records[id] = {
        agentId: DEFAULT_AGENT_ID,
        sessionId: {},
        title: null,
        cwd: { cwd: this.defaultCwd, locked: false },
        lastActiveAt: Date.now(),
      };
    }
  }
}
