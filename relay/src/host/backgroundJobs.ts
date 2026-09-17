import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "../protocol/agent-event.js";

// Tracks jobs started via `anywh-bg` (relay/scripts)
// outside the turn's process, since the CLI's internal record for
// `run_in_background`/`BashOutput` disappears along with that turn's
// `claude -p`. Doesn't trigger any follow-up turn yet (Phase D) — it only
// detects the start marker and watches for completion via the `.exit` file,
// to validate detection in isolation before coupling it to anything that
// affects the user.

export interface BackgroundJobStarted {
  id: string;
  pid: number;
  log: string;
  exitFile: string;
  /** Heartbeat file the wrapper touches every ~5s.
   * Optional: a marker printed by an older `anywh-bg` doesn't have it, and
   * a job without a heartbeat simply falls back to the previous behavior
   * (only `.exit` or the ceiling ever end it). */
  alive?: string;
  label: string;
}

export interface WatchedJob {
  sessionId: string;
  id: string;
  label: string;
  logPath: string;
  exitPath: string;
  startedAt: number;
  /** Path of the heartbeat file — `undefined` for a
   * job persisted before this existed, which keeps the old behavior. */
  alivePath?: string;
  /** PID reported by `anywh-bg start` — only used for
   * cancellation (`cancel`, `kill -<pid>` on the whole process group),
   * NEVER to detect completion (that's the `.exit` file's job; PID reuse by
   * the OS would mask a dead job as "still running"). `setsid` makes this
   * PID simultaneously the process's PID/PGID/SID — confirmed in practice —
   * so signaling the group (`-pid`) reaches
   * everything the command spawned, not just the root process. */
  pid: number;
}

/** Subset of `WatchedJob` safe to expose to the client —
 * without `logPath`/`exitPath` (server-side file paths, internal detail)
 * nor `sessionId` (already implicit in the session's WS connection). */
export interface BackgroundJobSummary {
  id: string;
  label: string;
  startedAt: number;
}

export function toBackgroundJobSummary(job: WatchedJob): BackgroundJobSummary {
  return { id: job.id, label: job.label, startedAt: job.startedAt };
}

export interface FinishedBackgroundJob extends WatchedJob {
  exitCode: number;
  logTail: string;
  /** The job didn't end on its own: the wrapper was
   * killed from the outside without ever writing `.exit` (detected via the
   * heartbeat going stale). There's no real exit code in this case
   * (`exitCode` is `-1`), and the command's own process tree MAY still be
   * alive if only the wrapper took the signal — so the follow-up message
   * has to say "terminated externally", not "failed with exit -1". */
  terminated?: true;
}

// Only the marker line (one of potentially several lines of a Bash call's
// stdout) — doesn't assume it's the whole string, so it survives any extra
// output before/after it.
const MARKER_RE = /\{"anywh_bg":"started".*\}/;

/**
 * Pure (no I/O) parser for the marker that `anywh-bg start` prints —
 * separated from `extractStartedJobFromEvent` so it can be tested against
 * loose strings without having to build a whole `AgentEvent`.
 */
export function parseStartedMarker(text: string): BackgroundJobStarted | undefined {
  const match = MARKER_RE.exec(text);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { anywh_bg, id, pid, log, exitFile, alive, label } = parsed as Record<string, unknown>;
  if (
    anywh_bg !== "started" ||
    typeof id !== "string" ||
    typeof pid !== "number" ||
    typeof log !== "string" ||
    typeof exitFile !== "string" ||
    typeof label !== "string"
  ) {
    return undefined;
  }
  // `alive` deliberately NOT required: the relay and the script are
  // updated by separate steps (`git pull` + rebuild vs. the copy the model
  // calls), so a marker without it has to keep working.
  return { id, pid, log, exitFile, label, ...(typeof alive === "string" ? { alive } : {}) };
}

/**
 * `tool_ended.content` is already flattened to a plain string by the
 * mapper that produces `AgentEvent` (`runtimes/streams/claudeStreamJson.ts`)
 * — this used to reach into the CLI's raw `tool_result` content-block array
 * itself (a string, or an array of text blocks) before that normalization
 * existed.
 */
export function extractStartedJobFromEvent(event: AgentEvent): BackgroundJobStarted | undefined {
  if (event.type !== "tool_ended") return undefined;
  return parseStartedMarker(event.content);
}

/** `undefined` = the file exists but is still EMPTY: an older wrapper
 * writes it with `echo $? > file`, and the redirect
 * creates the file before the content lands — a poll landing in that window
 * used to read `""` and report `-1`, announcing a job that passed as a
 * failure. The current wrapper writes it atomically (tmp + `mv`), but a job
 * started by the old one can still be in flight. */
function readExitCode(exitPath: string): number | undefined {
  const raw = readFileSync(exitPath, "utf8").trim();
  if (raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

/** `kill(pid, 0)` — signal 0 only checks existence/permission, never
 * delivers anything. `EPERM` means the PID exists but belongs to another
 * user, which for our purposes is still "alive". */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only the tail — same truncation pattern as `suggestionGenerator.ts`, but
 * reading only the last `maxBytes` of the file instead of loading everything
 * into memory (a noisy job can generate a large log). */
function readLogTail(logPath: string, maxBytes: number): string {
  const size = statSync(logPath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length === 0) return "";
  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface BackgroundJobTrackerOptions {
  /** Called when a watched job finishes — Phase D triggers the follow-up
   * turn from this (see `sessionManager.ts`). */
  onFinished: (job: FinishedBackgroundJob) => void;
  /** Fired whenever a session's list of watched jobs changes — start,
   * completion, OR expiry from the ceiling (`maxWatchMs`) —
   * this is what feeds the `background_job_state` the client uses for the
   * UI indicator ("there's a job running now"). Only `sessionId` — the
   * consumer fetches the current list via `listWatchedForSession`, it
   * doesn't get handed a ready-made array (avoids the callback going stale
   * if two changes happen in sequence before the listener reacts). */
  onChanged?: (sessionId: string) => void;
  /** ms between disk polls — split into an option (not a constant) just so
   * tests can use a short interval without depending on the production
   * value. */
  pollIntervalMs?: number;
  /** Observation ceiling — a job that never finishes (e.g. a dev server
   * left running on purpose) stops being watched after this, preventing the
   * list from growing unbounded. */
  maxWatchMs?: number;
  /** Log tail delivered in `FinishedBackgroundJob.logTail`. */
  logTailBytes?: number;
  /** How long without a heartbeat before a job is considered dead —
   * an option only so tests don't have to wait the
   * real value. */
  heartbeatStaleMs?: number;
  /** Path to the persistence file — if provided, the list
   * of watched jobs survives a relay restart: written on every change (same
   * synchronous pattern as `SessionStore`, `writeFileSync` of the whole
   * state), reloaded in the constructor, and polling resumed where it left
   * off. `undefined` (the tests' default) keeps the previous in-memory-only
   * behavior — without this, a restart mid-job would lose tracking forever
   * (edge case #10 of the plan). */
  persistPath?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_WATCH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOG_TAIL_BYTES = 4000;
/** 6 missed beats (the wrapper touches `.alive` every 5s) — generous on
 * purpose: a loaded machine can delay a `sleep 5` by a lot, and a false
 * "it died" costs a wrong report to the user. */
const DEFAULT_HEARTBEAT_STALE_MS = 30_000;

export class BackgroundJobTracker {
  private readonly jobs = new Map<string, WatchedJob>();
  private timer: NodeJS.Timeout | undefined;
  private readonly pollIntervalMs: number;
  private readonly maxWatchMs: number;
  private readonly logTailBytes: number;
  private readonly heartbeatStaleMs: number;

  constructor(private readonly options: BackgroundJobTrackerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWatchMs = options.maxWatchMs ?? DEFAULT_MAX_WATCH_MS;
    this.logTailBytes = options.logTailBytes ?? DEFAULT_LOG_TAIL_BYTES;
    this.heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;

    if (this.options.persistPath) {
      for (const job of this.load(this.options.persistPath)) {
        this.jobs.set(`${job.sessionId}:${job.id}`, job);
      }
      // A job may have finished (or expired) while the relay was down —
      // don't wait for the first `pollIntervalMs` to find out, resolve this
      // right at boot. `setImmediate` (not a synchronous call here inside
      // the constructor): real finding while testing restart — whoever
      // instantiates this (`SessionManager`) only assigns its own field
      // after THIS constructor returns; an `onChanged`/`onFinished` fired
      // too synchronously via `pollOnce()` reached `SessionManager`'s
      // callback BEFORE it finished storing the tracker's reference, and
      // `this.backgroundJobs` (there) was still `undefined`.
      if (this.jobs.size > 0) {
        this.ensurePolling();
        setImmediate(() => this.pollOnce());
      }
    }
  }

  /** Never throws — a missing file (first time) or a corrupted one just
   * starts empty, same pattern as `SessionStore.load`. */
  private load(persistPath: string): WatchedJob[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(persistPath, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is WatchedJob =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.sessionId === "string" &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.logPath === "string" &&
        typeof entry.exitPath === "string" &&
        (entry.alivePath === undefined || typeof entry.alivePath === "string") &&
        typeof entry.startedAt === "number" &&
        typeof entry.pid === "number",
    );
  }

  /** Writes the whole state on every mutation — same synchronous,
   * debounce-free pattern as `SessionStore`: job changes are rare
   * (start/finish/cancel, never on a poll tick), the cost of one more
   * `writeFileSync` doesn't matter. No-op if `persistPath` wasn't
   * configured. */
  private persist(): void {
    if (!this.options.persistPath) return;
    mkdirSync(dirname(this.options.persistPath), { recursive: true });
    writeFileSync(this.options.persistPath, JSON.stringify([...this.jobs.values()], null, 2));
  }

  /** Called with every `AgentEvent` of every turn (see
   * `SharedSession.runTurn`) — a no-op for almost all of them, only reacts
   * to the ones carrying the start marker. */
  observeEvent(sessionId: string, event: AgentEvent): void {
    const started = extractStartedJobFromEvent(event);
    if (!started) return;
    const key = `${sessionId}:${started.id}`;
    if (this.jobs.has(key)) return;
    this.jobs.set(key, {
      sessionId,
      id: started.id,
      label: started.label,
      logPath: started.log,
      exitPath: started.exitFile,
      alivePath: started.alive,
      startedAt: Date.now(),
      pid: started.pid,
    });
    this.ensurePolling();
    this.persist();
    this.options.onChanged?.(sessionId);
  }

  listWatched(): WatchedJob[] {
    return [...this.jobs.values()];
  }

  listWatchedForSession(sessionId: string): WatchedJob[] {
    return [...this.jobs.values()].filter((job) => job.sessionId === sessionId);
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** ms since the last heartbeat, or `undefined` for a job that doesn't
   * have one (started by an older `anywh-bg` that predates heartbeats).
   * A declared-but-missing file counts as "never beat since it started":
   * the wrapper creates it in its first milliseconds, so its absence past
   * the staleness window means it died before writing one, not that it's
   * healthy. */
  private heartbeatAgeMs(job: WatchedJob, now: number): number | undefined {
    if (!job.alivePath) return undefined;
    let lastBeat: number;
    try {
      lastBeat = statSync(job.alivePath).mtimeMs;
    } catch {
      lastBeat = job.startedAt;
    }
    return now - lastBeat;
  }

  /** The failure this fixes: `pkill -f "next dev"`
   * matches the WRAPPER's cmdline too (it carries the command string), so
   * `echo $? > .exit` never ran and the job stayed "running" in the UI
   * until the 6h ceiling, with the promised completion notice never
   * arriving. Two independent signals have to agree before declaring death:
   *
   * - stale heartbeat — the wrapper stopped touching `.alive`;
   * - the PID is gone — guards against the machine having been SUSPENDED
   *   (every process frozen while the wall clock advances, so on resume the
   *   heartbeat looks hours old even though the job is perfectly alive).
   *
   * Note the PID check can only ever VETO a death, never assert one by
   * itself — a PID recycled by
   * the OS at worst delays detection until the ceiling, it can never invent
   * a completion. */
  private isWrapperGone(job: WatchedJob, now: number): boolean {
    const age = this.heartbeatAgeMs(job, now);
    return age !== undefined && age > this.heartbeatStaleMs && !isProcessAlive(job.pid);
  }

  /** Single exit point for "this job is over" — drops it from the list,
   * persists, and notifies. Reads the log tail defensively: a log that
   * can't be read (deleted by hand, disk full) is worth reporting with an
   * empty tail, never worth swallowing the whole notification for. */
  private finish(key: string, job: WatchedJob, result: { exitCode: number; terminated?: true }): void {
    this.jobs.delete(key);
    let logTail = "";
    try {
      logTail = readLogTail(job.logPath, this.logTailBytes);
    } catch (error) {
      console.error(`[relay] failed reading background job log "${job.label}" (${job.id}):`, error);
    }
    this.persist();
    this.options.onFinished({ ...job, ...result, logTail });
    this.options.onChanged?.(job.sessionId);
  }

  /** Public only so tests can trigger a poll without waiting for the real
   * interval — `setInterval` in production calls this same method. */
  pollOnce(): void {
    const now = Date.now();
    for (const [key, job] of this.jobs) {
      if (now - job.startedAt > this.maxWatchMs) {
        console.warn(
          `[relay] background job "${job.label}" (${job.id}) expired without finishing after ${String(this.maxWatchMs)}ms — no longer watching`,
        );
        this.jobs.delete(key);
        this.persist();
        this.options.onChanged?.(job.sessionId);
        continue;
      }
      let exitCode: number | undefined;
      if (existsSync(job.exitPath)) {
        try {
          exitCode = readExitCode(job.exitPath);
        } catch (error) {
          // Unreadable (deleted mid-poll, permissions...) — report it as an
          // unknown result instead of leaving the job pinned forever.
          console.error(`[relay] failed reading background job result "${job.label}" (${job.id}):`, error);
          exitCode = -1;
        }
      }

      if (exitCode === undefined) {
        if (!this.isWrapperGone(job, now)) continue;
        console.warn(
          `[relay] background job "${job.label}" (${job.id}) died without writing .exit (killed from outside) — reporting as terminated`,
        );
        this.finish(key, job, { exitCode: -1, terminated: true });
        continue;
      }
      this.finish(key, job, { exitCode });
    }
    if (this.jobs.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Cancellation from the UI. Kills the WHOLE process
   * GROUP (negative `pid`, reaches everything the command spawned, not just
   * the root process), doesn't go through `.exit`/`onFinished`: unlike a job
   * that finishes on its own, whoever cancelled it already knows it was
   * cancelled (they clicked the button), an automatic follow-up turn
   * summarizing "it was cancelled" would be redundant noise. `SIGTERM`
   * first (gives a chance to clean up temp files etc.), `SIGKILL` ~2s later
   * for anything that ignores the first one — same standard practice as
   * tools like `timeout(1)`. Returns `false` with no effect if the job is
   * no longer being watched (it finished on its own or was already
   * cancelled before) — a race is possible between the user clicking
   * "cancel" and the next poll finding the `.exit`. */
  cancel(sessionId: string, jobId: string): boolean {
    const key = `${sessionId}:${jobId}`;
    const job = this.jobs.get(key);
    if (!job) return false;

    this.jobs.delete(key);
    this.persist();
    this.options.onChanged?.(sessionId);

    // Only signal if the heartbeat still vouches for this PID being OUR
    // job: a job persisted across a reboot carries a
    // PID the OS has long since handed to someone else, and `kill(-pid)`
    // would take down an unrelated process group. No heartbeat at all
    // (older wrapper) keeps the previous behavior.
    const heartbeatAge = this.heartbeatAgeMs(job, Date.now());
    if (heartbeatAge !== undefined && heartbeatAge > this.heartbeatStaleMs) {
      console.warn(
        `[relay] background job "${job.label}" (${job.id}) has no live heartbeat — dropped from the list without signalling PID ${String(job.pid)}`,
      );
      return true;
    }

    try {
      process.kill(-job.pid, "SIGTERM");
    } catch {
      // Group no longer exists (the job had just finished on its own right
      // at this instant) — nothing to kill, but the list was already updated above.
      return true;
    }
    setTimeout(() => {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        // Already died from the SIGTERM — expected in most cases.
      }
    }, 2000).unref();
    return true;
  }

  /** Only for tests/shutdown — production never needs to stop the poller
   * while the process is alive. */
  stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
