import { generateTitle } from "../runtimes/probes/titleGenerator.js";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import { SharedSession } from "./sharedSession.js";
import type { SessionStore, TitledSession } from "./sessionStore.js";
import { BackgroundJobTracker, type FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { WakeupScheduler } from "../host/wakeupScheduler.js";
import type { McpChoiceBridge } from "../bridges/mcpBridge.js";
import type { McpPermissionBridge } from "../bridges/permissionBridge.js";

/** A change to the sidebar's session list (title assigned/changed, or
 * session removed) — distinct from `SharedSession`'s own `session_title`/
 * `session_deleted` broadcasts, which only reach clients that already have
 * that specific session open. This one is for `server.ts` to relay to every
 * device watching the list itself (`/sessions/watch`), even devices that
 * never opened this session as a tab — e.g. a session created on mobile,
 * appearing live in the desktop sidebar. */
export type SessionListEvent =
  | { type: "upsert"; id: string; title: string; lastActiveAt: number }
  | { type: "remove"; id: string };

// Multiple sessions identified by id within the same profile (= one relay
// process) — equivalent to what tmux windows provided in the old
// architecture, now on top of the relay. Names used to be
// in-memory only (lost on every restart) — now they
// persist via SessionStore; at boot, we materialize a SharedSession for
// every id already persisted (cheap: the constructor does no I/O or spawn).
// `id` is stable since creation and never changes; `title` (shown in the UI)
// starts as `null` — only already-titled sessions go into `listTitled()`,
// which is what the sidebar lists.
export class SessionManager {
  private readonly sessions = new Map<string, SharedSession>();
  /** A single tracker for the whole process (not one per session) — `anywh-bg`
   * jobs from different sessions have no relation to each other, but the
   * poller and the observation ceiling make more sense
   * shared than duplicated N times. */
  private readonly backgroundJobs: BackgroundJobTracker;
  /** A single scheduler for the whole process, same reasoning as
   * `backgroundJobs` — a `ScheduleWakeup` timer belongs to one session, but
   * there's no reason to keep N independent instances of the mechanism that
   * arms/persists it. */
  private readonly wakeups: WakeupScheduler;

  constructor(
    private readonly homeOverride: string | undefined,
    private readonly sessionStore: SessionStore,
    /** File where `BackgroundJobTracker` persists the list
     * of watched jobs, to survive a relay restart. Same optional `undefined`
     * that `BackgroundJobTrackerOptions.persistPath` accepts (used by tests
     * that don't pass this), but in production `server.ts` always passes a
     * real path. */
    backgroundJobsFilePath?: string,
    /** Same reasoning as `backgroundJobsFilePath`, for `WakeupScheduler`. */
    wakeupsFilePath?: string,
    /** `undefined` in tests that don't exercise `present_choice`,
     * same reasoning as `backgroundJobsFilePath`; in production `server.ts`
     * always passes both. */
    private readonly mcpChoiceBridge?: McpChoiceBridge,
    private readonly mcpBridgeBaseUrl?: string,
    /** Same "undefined only in tests" reasoning as
     * `mcpChoiceBridge`/`mcpBridgeBaseUrl`. */
    private readonly mcpPermissionBridge?: McpPermissionBridge,
    private readonly mcpPermissionBridgeBaseUrl?: string,
    /** `undefined` in tests that don't exercise `/sessions/watch` — same
     * reasoning as `mcpChoiceBridge`; in production `server.ts` always
     * passes it, wired to broadcast to every connected watcher socket. */
    private readonly onListChanged?: (event: SessionListEvent) => void,
  ) {
    // `this.sessions` needs to exist BEFORE `BackgroundJobTracker` is
    // constructed: if there are persisted jobs from a session that already
    // finished while the relay was down (Phase F), the tracker's
    // constructor schedules an immediate poll (`setImmediate`, not
    // synchronous — real finding: it was synchronous in an earlier version,
    // and `onFinished`/`onChanged` fired BEFORE `this.backgroundJobs` even
    // finished being assigned here, hanging the boot with `TypeError:
    // Cannot read properties of undefined`) to find this out without
    // waiting for the first normal poll — but even deferred, it runs before
    // any client connects; if `this.sessions` were still empty at that
    // point, `handleBackgroundJobFinished` would think the session
    // "doesn't exist" and discard the follow-up for nothing, even though it
    // genuinely exists.
    for (const id of sessionStore.listIds()) {
      this.sessions.set(id, this.createSession(id));
    }
    this.backgroundJobs = new BackgroundJobTracker({
      onFinished: (job) => this.handleBackgroundJobFinished(job),
      onChanged: (sessionId) => this.syncBackgroundJobState(sessionId),
      persistPath: backgroundJobsFilePath,
    });
    // Jobs reloaded from disk that are STILL running (not captured by the
    // synchronous `onChanged` above, which only fires on finish/expiry) —
    // sync their `background_job_state` now, not only when the tracker
    // detects the next change.
    for (const job of this.backgroundJobs.listWatched()) {
      this.syncBackgroundJobState(job.sessionId);
    }
    // Same ordering requirement as `BackgroundJobTracker` above: a wakeup
    // reloaded from disk whose `fireAt` already passed fires immediately
    // (`setTimeout(..., 0)`, not synchronous), and `handleWakeupFired` needs
    // `this.sessions` fully populated by then to find the session to deliver
    // it to — hence constructed after the loop above, not before it.
    this.wakeups = new WakeupScheduler({
      onFire: (sessionId, prompt) => this.handleWakeupFired(sessionId, prompt),
      persistPath: wakeupsFilePath,
    });
  }

  /** Called by `BackgroundJobTracker` when a job finishes.
   * `this.sessions.get` (not `getOrCreate`): if the session was deleted
   * while the job was running, there's no one to report to — discard
   * silently instead of resurrecting an entry in `SessionStore`. */
  private handleBackgroundJobFinished(job: FinishedBackgroundJob): void {
    const session = this.sessions.get(job.sessionId);
    if (!session) {
      console.warn(
        `[relay] background job "${job.label}" (${job.id}) finished, but session ${job.sessionId} no longer exists — discarding`,
      );
      return;
    }
    session.submitBackgroundJobResult(job);
  }

  /** Called by `WakeupScheduler` when an armed `ScheduleWakeup` timer
   * fires. Same "session might be gone" guard as
   * `handleBackgroundJobFinished` — a race between the session being
   * deleted and the timer firing is possible (`deleteSession` cancels the
   * timer, but can't stop one that already fired in the same tick). */
  private handleWakeupFired(sessionId: string, prompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[relay] wakeup fired for session ${sessionId}, but it no longer exists — discarding`);
      return;
    }
    session.submitWakeup(prompt);
  }

  /** Keeps the `background_job_state` that `SharedSession`
   * exposes to the client in sync with the tracker whenever a session's list
   * of watched jobs changes (start, finish, or expiry). A session with no
   * open tab (`this.sessions.get` undefined) simply has no one to send it
   * to — no effect, the tracker remains the source of truth. */
  private syncBackgroundJobState(sessionId: string): void {
    this.sessions.get(sessionId)?.setBackgroundJobs(this.backgroundJobs.listWatchedForSession(sessionId));
  }

  listTitled(): TitledSession[] {
    return this.sessionStore.listTitled();
  }

  /** The timestamp to stamp an `upsert` event with. Read back from the store
   * rather than taken as `Date.now()`: a manual rename doesn't touch
   * `lastActiveAt`, so reporting "now" would make every other device file a
   * years-old session under "today" the moment someone renames it. Falls
   * back to now only for an id the store somehow doesn't know, which can't
   * happen on either of the two call sites below. */
  lastActiveAtOf(id: string): number {
    return this.sessionStore.getLastActiveAt(id) ?? Date.now();
  }

  /** Resolves when no session has a turn in progress — used by graceful
   * shutdown (server.ts) before letting the process exit. */
  async waitForAllIdle(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.waitForIdle()));
  }

  /** Interrupts (SIGINT, same path as the "Stop" button) the turn in
   * progress for every session — used only as a graceful shutdown fallback
   * when the normal wait deadline runs out, to end quickly and cleanly
   * instead of letting systemd kill the raw `claude -p` processes. */
  stopAllTurns(): void {
    for (const session of this.sessions.values()) session.stopTurn();
  }

  getOrCreate(id: string): SharedSession {
    let session = this.sessions.get(id);
    if (!session) {
      this.sessionStore.recordId(id);
      session = this.createSession(id);
      this.sessions.set(id, session);
    }
    return session;
  }

  /** Manual rename (sidebar dialog) — works even for a session with no tab
   * currently open (`sessions.get` may return `undefined`; only the
   * SessionStore needs to exist). If the session is open on some device,
   * `SharedSession.setTitle` propagates the change live. */
  renameTitle(id: string, title: string): boolean {
    if (this.sessionStore.getTitle(id) === null && !this.sessions.has(id)) return false;
    this.sessionStore.setTitle(id, title);
    this.sessions.get(id)?.setTitle(title);
    this.onListChanged?.({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
    return true;
  }

  /** Only removes the session from anywh's control (SessionStore +
   * in-memory map) — doesn't delete the transcript that Claude Code already
   * maintains on its own in `~/.claude/projects/`. Stops the turn in
   * progress (if any) and notifies whoever is connected before dropping the
   * connection. */
  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      session.stopTurn();
      session.closeAllClients();
      this.sessions.delete(id);
    }
    // The only real way a session "dies" today (closing a tab/disconnecting
    // a WS doesn't touch the `SharedSession`) — a wakeup armed for an id
    // that no longer exists would otherwise fire into a session
    // `handleWakeupFired` can't find, which it already tolerates, but
    // there's no reason to let it linger until then.
    this.wakeups.cancelForSession(id);
    const existedInStore = this.sessionStore.deleteEntry(id);
    const existed = existedInStore || session !== undefined;
    if (existed) this.onListChanged?.({ type: "remove", id });
    return existed;
  }

  private createSession(id: string): SharedSession {
    const { cwd, locked } = this.sessionStore.getCwdState(id);
    // Every session's agent today — see SessionStore.getAgentId's own
    // comment for why this isn't picked per-call yet. Read once so every
    // sessionId/permissionMode/model access below is scoped to the same
    // agent.
    const agentId = this.sessionStore.getAgentId(id);
    // `agentId` isn't resolved against a registry yet (no `Registry` is
    // threaded into `SessionManager` today) — every session still gets
    // Claude's def regardless of what `agentId` says, same behavior as
    // before `def` became an explicit field on `SharedSessionOptions`.
    const session = new SharedSession(this.homeOverride, {
      def: claudeRuntimeDef,
      initialSessionId: this.sessionStore.getSessionId(id, agentId),
      onSessionIdChange: (sessionId) => this.sessionStore.recordSessionId(id, agentId, sessionId),
      onSessionIdClear: () => this.sessionStore.clearSessionId(id, agentId),
      onTitleClear: () => this.sessionStore.clearTitle(id),
      initialCwd: cwd,
      initialLocked: locked,
      onCwdChange: (newCwd) => this.sessionStore.setCwd(id, newCwd),
      onLockChange: () => this.sessionStore.lockCwd(id),
      onUnlockChange: () => this.sessionStore.unlockCwd(id),
      initialPermissionMode: this.sessionStore.getPermissionMode(id, agentId),
      onPermissionModeChange: (mode) => this.sessionStore.setPermissionMode(id, agentId, mode),
      initialModel: this.sessionStore.getModel(id, agentId),
      onModelChange: (model) => this.sessionStore.setModel(id, agentId, model),
      initialContextUsage: this.sessionStore.getContextUsage(id),
      onContextUsageChange: (usage) => this.sessionStore.setContextUsage(id, usage),
      initialDraft: this.sessionStore.getDraft(id),
      onDraftChange: (text) => this.sessionStore.setDraft(id, text),
      initialSuggestion: this.sessionStore.getSuggestion(id),
      onSuggestionChange: (text) => this.sessionStore.setSuggestion(id, text),
      mcpChoiceBridge: this.mcpChoiceBridge,
      mcpBridgeBaseUrl: this.mcpBridgeBaseUrl,
      mcpPermissionBridge: this.mcpPermissionBridge,
      mcpPermissionBridgeBaseUrl: this.mcpPermissionBridgeBaseUrl,
      onActivity: () => this.sessionStore.touch(id),
      onEvent: (event) => {
        this.backgroundJobs.observeEvent(id, event);
        this.wakeups.observeEvent(id, event);
      },
      onCancelBackgroundJob: (jobId) => {
        this.backgroundJobs.cancel(id, jobId);
      },
      onCancelWakeup: () => {
        this.wakeups.cancelForSession(id);
      },
      initialTitle: this.sessionStore.getTitle(id),
      onFirstPrompt: (text) => {
        // Guards against overwriting an already-titled session: a session
        // migrated from an old format arrives with `initialTitle` filled in
        // (its name at the time), so it never had a null `title` to begin
        // with. A cleared conversation (`SharedSession.onTitleClear`)
        // is the other way this can fire with a title already set — there it
        // doesn't apply, since `clearConversation` already nulled it out.
        if (this.sessionStore.getTitle(id) !== null) return;
        generateTitle(this.homeOverride, session.getCwdState().cwd, text)
          .then((title) => {
            // Null means the first prompt had no text worth a title and the
            // model gave nothing back either. The session stays untitled and
            // the client names it, rather than the relay writing a name in a
            // language nobody picked.
            if (title === null) return;
            this.sessionStore.setTitle(id, title);
            session.setTitle(title);
            this.onListChanged?.({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
          })
          .catch((error: unknown) => {
            console.error("[relay] failed to generate session title:", error);
          });
      },
    });
    return session;
  }
}
