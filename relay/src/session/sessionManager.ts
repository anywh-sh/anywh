import type { AgentEvent } from "../protocol/agent-event.js";
import { generateTitle } from "../runtimes/probes/titleGenerator.js";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import type { Registry } from "../runtimes/registry.js";
import type { PushNotificationDraft } from "../push/events.js";
import { SharedSession, type TurnOutcome } from "./sharedSession.js";
import type { SessionStore, TitledSession } from "./sessionStore.js";
import { BackgroundJobTracker, type FinishedBackgroundJob } from "../host/backgroundJobs.js";
import { WakeupScheduler } from "../host/wakeupScheduler.js";
import type { McpChoiceBridge } from "../bridges/mcpBridge.js";
import type { McpPermissionBridge } from "../bridges/permissionBridge.js";
import type { ModelCatalog, RoomAgentSetup } from "../runtimes/types.js";
import type { FileCursorStore, HostClient } from "../agentHost/hostClient.js";

/** What a relay with rooms adds to its sessions. */
/** How long a room agent's title is shown as a placeholder before the
 * provisional text is shown after all: a title generation that hangs (the CLI
 * never answers) must not leave a card blank for good. A title that arrives
 * later still replaces the provisional one. */
export const TITLE_PENDING_MAX_MS = 30_000;

export interface SessionManagerRoomOptions {
  /** Replaces the title generator (tests); the real one spawns the CLI. */
  readonly titleGenerator?: typeof generateTitle;
  /** Replaces `TITLE_PENDING_MAX_MS` (tests). */
  readonly titlePendingMaxMs?: number;
  /** This profile's agent host, where every agent of a room runs.
   * `undefined` when the relay has none: a room's turns then fail with an
   * explanation instead of silently running somewhere else. */
  readonly agentHost?: HostClient;
  /** The room wiring of a member (its instructions and tools), read at
   * every turn. */
  readonly roomSetup?: (sessionId: string) => RoomAgentSetup | undefined;
  /** A room's principal was deleted (its workers with it). */
  readonly onRoomDeleted?: (roomId: string) => void;
  /** Why a member may not run a turn now (stopped, room gone), if so. */
  readonly admit?: (sessionId: string) => string | undefined;
  /** A member's turn ended. */
  readonly onTurnSettled?: (sessionId: string, outcome: TurnOutcome) => void;
  /** Where each room agent's log was last read up to. */
  readonly cursors?: Pick<FileCursorStore, "get" | "set" | "delete" | "flush">;
  /** This relay's id for its agents in the host. */
  readonly owner?: string;
  /** A room member's session was deleted. */
  readonly onMemberDeleted?: (sessionId: string) => void;
  /** A worker asked the person something (a question or a tool approval). */
  readonly onWorkerPrompted?: (sessionId: string, watched: boolean) => void;
  /** A member's turn started or ended. */
  readonly onMemberChanged?: (sessionId: string) => void;
  /** A usage event of a member's turn. */
  readonly onUsage?: (sessionId: string, event: AgentEvent) => void;
  /** See `SharedSessionOptions.onTurnStarted`. */
  readonly onTurnStarted?: (sessionId: string, startedAt: number, synthetic?: "background_job" | "wakeup" | "approval" | "room_digest") => void;
  /** See `SharedSessionOptions.onMcpServerUsed`. */
  readonly onMcpServerUsed?: (sessionId: string, server: string) => void;
  /** See `SharedSessionOptions.roomTurnNote`. */
  readonly turnNote?: (sessionId: string) => { text: string; commit: () => void } | undefined;
  /** Why a member's card cannot be answered now (the room is full), if so. */
  readonly answerRefusal?: (sessionId: string) => "room_cap_reached" | undefined;
}

/** A change to the sidebar's session list (title assigned/changed, or
 * session removed) — distinct from `SharedSession`'s own `session_title`/
 * `session_deleted` broadcasts, which only reach clients that already have
 * that specific session open. This one is for `server.ts` to relay to every
 * device watching the list itself (`/sessions/watch`), even devices that
 * never opened this session as a tab — e.g. a session created on mobile,
 * appearing live in the desktop sidebar. */
export type SessionListEvent =
  | { type: "upsert"; id: string; title: string; lastActiveAt: number; room?: true; titlePending?: true }
  | { type: "remove"; id: string };

/** What makes a session different from one a person types into. */
export interface SessionTraits {
  /** See `SharedSessionOptions.agentWorker`. */
  agentWorker?: boolean;
  /** See `SharedSessionOptions.deferredApproval`. */
  deferredApproval?: boolean;
}

/** A notification-worthy moment in one session, as `server.ts` receives it. */
export type SessionPushEvent = PushNotificationDraft & { sessionId: string; ts: number; watched: boolean };

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
    /** Every `AgentRuntimeDef` this relay can actually drive a turn with —
     * built once in `server.ts` (`buildRegistry([claudeRuntimeDef,
     * codexRuntimeDef])`) and threaded down here so `createSession` can
     * resolve a session's persisted `agentId` to a real def instead of the
     * `claudeRuntimeDef` literal it used before this. */
    private readonly registry: Registry,
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
    /** `undefined` when push is off (or in tests that don't exercise it) —
     * `server.ts` wires it to the push dispatcher. */
    private readonly onPushNotifiable?: (event: SessionPushEvent) => void,
    /** The probed model catalogs, read at call time (they arrive after boot).
     * `undefined` in tests that don't exercise effort. */
    private readonly getModelCatalog?: (agentId: string) => ModelCatalog | undefined,
    /** Per-session behaviour switches, read when the session is created.
     * `undefined` means every session is an ordinary one. */
    private readonly sessionTraits?: (id: string) => SessionTraits,
    private readonly rooms: SessionManagerRoomOptions = {},
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
      // Test-only override, same pattern as `AGENT_BIN`/`SYSTEMCTL_BIN`
      // (runtimes/executables.ts): an integration test writing a real
      // `.exit` file needs the tracker to notice it without waiting out the
      // 10s production poll interval. Unset in production — `server.ts`
      // never sets this var.
      ...(process.env.BACKGROUND_JOB_POLL_MS ? { pollIntervalMs: Number(process.env.BACKGROUND_JOB_POLL_MS) } : {}),
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

  /** Reports a sidebar list change, except for a room's workers: they are
   * reached through their room and never listed on their own (the store's
   * `listTitled` leaves them out the same way). */
  private announce(event: SessionListEvent): void {
    if (event.type === "upsert" && this.sessionStore.isHiddenWorker(event.id)) return;
    if (event.type !== "upsert") {
      this.onListChanged?.(event);
      return;
    }
    this.onListChanged?.({
      ...event,
      ...(this.sessionStore.getRoom(event.id)?.role === "principal" ? { room: true as const } : {}),
      ...(this.sessionStore.isTitlePending(event.id) ? { titlePending: true as const } : {}),
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

  /** See `BackgroundJobTracker.readLiveLogTail`. */
  readBackgroundJobLog(sessionId: string, jobId: string): string | undefined {
    return this.backgroundJobs.readLiveLogTail(sessionId, jobId);
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
    // A room's agents run in the agent host and go on through the restart.
    for (const session of this.sessions.values()) if (!session.runsOutsideRelay()) session.stopTurn();
  }

  /** Tears down every session's driver — called once, from
   * `gracefulShutdown` (lifecycle.ts), right before the process exits.
   * A no-op for a Claude-driven session today (nothing outlives a single
   * turn there), but load-bearing the day a session is driving a Codex
   * daemon: without this, a relay restart would leak one orphaned
   * `codex app-server` process per session that ever ran a live turn,
   * on top of that daemon's own 15-minute idle reaper as a second line of
   * defense. */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    // Its writes are debounced on a timer that does not hold the process.
    this.rooms.cursors?.flush();
  }

  /** The session if it is live, without creating it. */
  peek(id: string): SharedSession | undefined {
    return this.sessions.get(id);
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

  /** Titles a session from `text` with the same generator an ordinary
   * session's first prompt uses, for a caller that already gave the session a
   * provisional title (a room's principal and its workers are titled when
   * they are made, so `onFirstPrompt` never fires for them). The provisional
   * title stays until the generated one lands; a rename or `/clear` in the
   * meantime wins, same as for an ordinary session. */
  generateTitle(id: string, text: string): void {
    const session = this.getOrCreate(id);
    this.markTitlePending(id);
    this.runTitleGeneration(id, session, text, session.currentTitleGeneration(), true);
  }

  private readonly titlePendingTimers = new Map<string, NodeJS.Timeout>();

  /** From now until the generated title lands, fails or times out, clients
   * draw a placeholder for `id` rather than its provisional title. */
  private markTitlePending(id: string): void {
    this.sessionStore.setTitlePending(id, true);
    clearTimeout(this.titlePendingTimers.get(id));
    const timer = setTimeout(() => this.settleTitlePending(id), this.rooms.titlePendingMaxMs ?? TITLE_PENDING_MAX_MS);
    timer.unref();
    this.titlePendingTimers.set(id, timer);
    this.announceTitle(id);
  }

  /** Ends the wait without telling the list (the caller is about to). */
  private clearTitlePending(id: string): void {
    clearTimeout(this.titlePendingTimers.get(id));
    this.titlePendingTimers.delete(id);
    this.sessionStore.setTitlePending(id, false);
  }

  /** Ends the wait and tells the list: the provisional title stays. */
  private settleTitlePending(id: string): void {
    if (!this.sessionStore.isTitlePending(id)) return;
    this.clearTitlePending(id);
    this.announceTitle(id);
  }

  private announceTitle(id: string): void {
    const title = this.sessionStore.getTitle(id);
    if (title !== null) this.announce({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
  }

  private runTitleGeneration(id: string, session: SharedSession, text: string, generation: number, tracked = false): void {
    // Re-resolves the current agent rather than closing over a def: `setAgent`/`switchAgent` mutate
    // the same `SharedSession` in place.
    const currentDef = this.registry.get(this.sessionStore.getAgentId(id)) ?? claudeRuntimeDef;
    void (async () => {
      try {
        const title = await (this.rooms.titleGenerator ?? generateTitle)(currentDef, this.homeOverride, session.getCwdState().cwd, text);
        // Null means the prompt had no text worth a title and the model gave
        // nothing back either. The session stays as it was and the client
        // names it, rather than the relay writing a name in a language
        // nobody picked.
        if (title === null) return;
        // `generation` is stale once `/clear` or a manual rename moved the
        // session past it while this was in flight — writing anyway would
        // either resurrect a title for a conversation that no longer exists
        // or stomp a rename that landed first. A session that was deleted
        // meanwhile must not get its record back either.
        if (!session.isCurrentTitleGeneration(generation) || this.sessions.get(id) !== session) return;
        // Cleared before the title is written, so the room's next update
        // carries both at once.
        this.clearTitlePending(id);
        this.sessionStore.setTitle(id, title);
        session.setTitle(title);
        this.announce({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
      } catch (error: unknown) {
        console.error("[relay] failed to generate session title:", error);
      } finally {
        // Nothing to write (no usable text, a stale generation, a failure):
        // the provisional title is what stays, and it is shown from now on.
        if (tracked) this.settleTitlePending(id);
      }
    })();
  }

  /** Manual rename (sidebar dialog) — works even for a session with no tab
   * currently open (`sessions.get` may return `undefined`; only the
   * SessionStore needs to exist). If the session is open on some device,
   * `SharedSession.setTitle` propagates the change live. */
  renameTitle(id: string, title: string): boolean {
    if (this.sessionStore.getTitle(id) === null && !this.sessions.has(id)) return false;
    // A name given by hand is final: no generated one is waited for.
    this.clearTitlePending(id);
    this.sessionStore.setTitle(id, title);
    this.sessions.get(id)?.setTitle(title);
    this.announce({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
    return true;
  }

  /** Switches which agent def a live session's turns run against, without
   * losing its transcript (the log is the conversation's, not an agent's).
   * The store, not `SharedSession`, owns "which agent" — same division as
   * every other persisted field here — so this is the one place that
   * resolves the new def and orchestrates both sides of the switch. A no-op
   * for an id the registry doesn't recognize (an id from a build with a def
   * this one's registry doesn't ship) rather than a thrown error the client
   * has no way to react to. Works even for a session with no tab currently
   * open, same as `renameTitle` — only `sessions.get` may be `undefined`. */
  setAgent(id: string, agentId: string): void {
    const def = this.registry.get(agentId);
    if (!def) return;
    // A room's agent keeps the runtime it was created with: the room never
    // swaps one agent for another.
    if (this.sessionStore.getRoom(id)) return;
    this.sessionStore.setAgentId(id, agentId);
    this.sessions.get(id)?.switchAgent({
      def,
      initialSessionId: this.sessionStore.getSessionId(id, agentId),
      initialPermissionMode: this.sessionStore.getPermissionMode(id, agentId, def.permissions.defaultModeId),
      initialModel: this.sessionStore.getModel(id, agentId),
      initialEffort: this.sessionStore.getEffort(id, agentId),
    });
  }

  /** Only removes the session from anywh's control (SessionStore +
   * in-memory map) — doesn't delete the transcript that Claude Code already
   * maintains on its own in `~/.claude/projects/`. Stops the turn in
   * progress (if any) and notifies whoever is connected before dropping the
   * connection. */
  deleteSession(id: string): boolean {
    this.clearTitlePending(id);
    const room = this.sessionStore.getRoom(id);
    if (room?.role === "principal" && room.roomId === id) {
      // A room goes as a whole: its workers have no way in but through it.
      for (const member of this.sessionStore.listRoomMembers(id)) if (member.id !== id) this.deleteSession(member.id);
      this.rooms.onRoomDeleted?.(id);
    } else if (room?.role === "worker") {
      // Removing an agent removes the agents below it (they report to it),
      // and its report no longer waits for whoever it was to be handed to.
      for (const member of this.sessionStore.listRoomMembers(room.roomId)) {
        if (member.room.parentId === id && member.id !== id) this.deleteSession(member.id);
      }
      for (const member of this.sessionStore.listRoomMembers(room.roomId)) {
        if (member.room.undeliveredReports?.includes(id)) {
          this.sessionStore.setRoom(member.id, { ...member.room, undeliveredReports: member.room.undeliveredReports.filter((other) => other !== id) });
        }
      }
    }
    if (room) {
      this.rooms.cursors?.delete(id);
      this.rooms.onMemberDeleted?.(id);
    }
    const session = this.sessions.get(id);
    // Nothing still queued for it runs (its driver refuses anyway once disposed).
    session?.discardQueuedTurns();
    // A room's agent lives in the agent host: deleting its session removes
    // it there too (best effort — a host that is down keeps it until a later
    // removal; its process would be stopped on the host's next start).
    if (this.sessionStore.getRoom(id) && this.rooms.agentHost) {
      this.rooms.agentHost.request("remove", { agentId: id }).catch((error: unknown) => {
        console.warn(`[relay] could not remove agent ${id} from the agent host: ${(error as Error).message}`);
      });
    }
    if (session) {
      session.stopTurn();
      session.closeAllClients();
      session.dispose();
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
    if (existed) this.announce({ type: "remove", id });
    return existed;
  }

  private createSession(id: string): SharedSession {
    const { cwd, locked } = this.sessionStore.getCwdState(id);
    // Read once so every sessionId/permissionMode/model access below is
    // scoped to the same agent — `setAgent` is the only thing that changes
    // it afterward, and it re-reads this fresh rather than mutating a
    // session already under construction.
    const agentId = this.sessionStore.getAgentId(id);
    // Falls back to Claude's def for an agentId the registry doesn't
    // recognize — an id from a build with a def this one's registry
    // excluded (assertCoherent failed) or simply doesn't ship, rather than
    // SharedSession's constructor throwing on an undefined def.
    const def = this.registry.get(agentId) ?? claudeRuntimeDef;
    const room = this.sessionStore.getRoom(id);
    const session = new SharedSession(this.homeOverride, {
      def,
      ...(room
        ? {
            hostAgent: { client: this.rooms.agentHost, agentId: id, roomId: room.roomId, setup: () => this.rooms.roomSetup?.(id), admit: () => this.rooms.admit?.(id), ...(this.rooms.cursors ? { cursors: this.rooms.cursors } : {}), ...(this.rooms.owner ? { owner: this.rooms.owner } : {}), onSubtasksChanged: () => this.rooms.onMemberChanged?.(id) },
            onTurnSettled: (outcome: TurnOutcome) => this.rooms.onTurnSettled?.(id, outcome),
            onTurnStateChange: () => this.rooms.onMemberChanged?.(id),
            onUsage: (event: AgentEvent) => this.rooms.onUsage?.(id, event),
            onTurnStarted: (startedAt, synthetic) => this.rooms.onTurnStarted?.(id, startedAt, synthetic),
            onMcpServerUsed: (server: string) => this.rooms.onMcpServerUsed?.(id, server),
            roomTurnNote: () => this.rooms.turnNote?.(id),
            answerRefusal: () => this.rooms.answerRefusal?.(id),
          }
        : {}),
      // Nobody types into a worker: no suggestion to generate after its turns.
      ...(room?.role === "worker" ? { suggestNextMessage: false } : {}),
      initialSessionId: this.sessionStore.getSessionId(id, agentId),
      // Re-reads the agent at call time rather than closing over the
      // `agentId` resolved above: after `setAgent` (below) switches a live
      // session, these same callbacks keep firing for whichever agent is
      // CURRENT when they fire, not the one active when the session was
      // constructed — otherwise a Codex turn's session id would get written
      // under Claude's key in SessionStore.
      onSessionIdChange: (sessionId) => this.sessionStore.recordSessionId(id, this.sessionStore.getAgentId(id), sessionId),
      onSessionIdClear: () => this.sessionStore.clearSessionId(id, this.sessionStore.getAgentId(id)),
      onTitleClear: () => {
        // `/clear` (or editing back to the first message) takes the session
        // out of `listTitled()` until its next prompt gets a fresh title —
        // every other device has to drop the row too, not just this one.
        const wasListed = this.sessionStore.getTitle(id) !== null;
        this.sessionStore.clearTitle(id);
        if (wasListed) this.announce({ type: "remove", id });
      },
      initialCwd: cwd,
      initialLocked: locked,
      onCwdChange: (newCwd) => this.sessionStore.setCwd(id, newCwd),
      onLockChange: () => this.sessionStore.lockCwd(id),
      onUnlockChange: () => this.sessionStore.unlockCwd(id),
      initialPermissionMode: this.sessionStore.getPermissionMode(id, agentId, def.permissions.defaultModeId),
      onPermissionModeChange: (mode) => this.sessionStore.setPermissionMode(id, this.sessionStore.getAgentId(id), mode),
      initialModel: this.sessionStore.getModel(id, agentId),
      onModelChange: (model) => this.sessionStore.setModel(id, this.sessionStore.getAgentId(id), model),
      initialEffort: this.sessionStore.getEffort(id, agentId),
      onEffortChange: (effort) => this.sessionStore.setEffort(id, this.sessionStore.getAgentId(id), effort),
      ...(this.getModelCatalog ? { getModelCatalog: this.getModelCatalog } : {}),
      initialContextUsage: this.sessionStore.getContextUsage(id, agentId),
      onContextUsageChange: (usage) => this.sessionStore.setContextUsage(id, this.sessionStore.getAgentId(id), usage),
      initialDraft: this.sessionStore.getDraft(id),
      onDraftChange: (text) => this.sessionStore.setDraft(id, text),
      initialSuggestion: this.sessionStore.getSuggestion(id),
      onSuggestionChange: (text) => this.sessionStore.setSuggestion(id, text),
      initialPendingChoice: this.sessionStore.getPendingChoice(id),
      onPendingChoiceChange: (choice) => this.sessionStore.setPendingChoice(id, choice),
      initialPendingApproval: this.sessionStore.getPendingApproval(id),
      onPendingApprovalChange: (approval) => this.sessionStore.setPendingApproval(id, approval),
      initialQueuedApproval: this.sessionStore.getQueuedApproval(id),
      onQueuedApprovalChange: (approval) => this.sessionStore.setQueuedApproval(id, approval),
      initialWithdrawnApproval: this.sessionStore.getWithdrawnApproval(id),
      onWithdrawnApprovalChange: (withdrawn) => this.sessionStore.setWithdrawnApproval(id, withdrawn),
      ...this.sessionTraits?.(id),
      mcpChoiceBridge: this.mcpChoiceBridge,
      mcpBridgeBaseUrl: this.mcpBridgeBaseUrl,
      mcpPermissionBridge: this.mcpPermissionBridge,
      mcpPermissionBridgeBaseUrl: this.mcpPermissionBridgeBaseUrl,
      onActivity: () => {
        this.sessionStore.touch(id);
        // Once per turn, not per streamed event — cheap enough to fan out,
        // and what lets another device move the session back to the top
        // instead of only the one that sent the message. An untitled
        // session isn't listed yet; its title upsert announces it below.
        const title = this.sessionStore.getTitle(id);
        if (title !== null) this.announce({ type: "upsert", id, title, lastActiveAt: this.lastActiveAtOf(id) });
      },
      // A worker's turns end all the time while the room works; the person
      // hears from the room, not from each of its workers.
      onNotifiable: (draft, watched) => {
        if (this.sessionStore.getRoom(id)?.role === "worker") {
          if (draft.kind === "approval_required" || draft.kind === "choice_required") this.rooms.onWorkerPrompted?.(id, watched);
          return;
        }
        this.onPushNotifiable?.({ ...draft, sessionId: id, ts: Date.now(), watched });
      },
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
      onFirstPrompt: (text, generation) => {
        // Guards against overwriting an already-titled session: a session
        // migrated from an old format arrives with `initialTitle` filled in
        // (its name at the time), so it never had a null `title` to begin
        // with. A cleared conversation (`SharedSession.onTitleClear`)
        // is the other way this can fire with a title already set — there it
        // doesn't apply, since `clearConversation` already nulled it out.
        if (this.sessionStore.getTitle(id) !== null) return;
        this.runTitleGeneration(id, session, text, generation);
      },
    });
    return session;
  }
}
