import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 * is fetched from the CLI itself (defaultModel.ts's `/model` probe) instead
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
  /** Optional for the same reason as `permissionMode`: tolerates records
   * written before this feature existed. Never rebuilt from Claude Code's
   * `.jsonl` on a restart — the `result` event (the only source of the real
   * per-model limit) only exists in `claude -p`'s live stdout, it's never
   * persisted in the transcript. That's why it needs to be recorded here on
   * every turn, otherwise it disappears for the client until the next turn
   * runs. */
  contextUsage?: ContextUsage;
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

export class SessionStore {
  private records: SessionRecord;
  private migrated = false;

  constructor(
    private readonly filePath: string,
    private readonly defaultCwd: string,
  ) {
    this.records = this.load();
    if (this.migrated) this.persist();
  }

  private load(): SessionRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      // File missing the first time, or corrupted — never crash the relay
      // because of this, just start with an empty mapping.
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

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
        const { sessionId, permissionMode, model, ...rest } = entry;
        migrated[id] = {
          ...rest,
          agentId: DEFAULT_AGENT_ID,
          sessionId: { [DEFAULT_AGENT_ID]: sessionId },
          ...(permissionMode !== undefined ? { permissionMode: { [DEFAULT_AGENT_ID]: permissionMode } } : {}),
          ...(model !== undefined ? { model: { [DEFAULT_AGENT_ID]: model } } : {}),
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
      .filter((entry): entry is [string, SessionEntry & { title: string }] => entry[1].title !== null)
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

  getContextUsage(id: string): ContextUsage | undefined {
    return this.records[id]?.contextUsage;
  }

  setContextUsage(id: string, usage: ContextUsage): void {
    this.ensureEntry(id);
    this.records[id].contextUsage = usage;
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
