// Client for our own relay protocol (no longer the ttyd protocol).
import type {
  AgentEvent,
  BackgroundJobSummary,
  ChoiceAnswer,
  ChoiceQuestion,
  ContextUsage,
  CreatedProfile,
  EditMessageErrorCode,
  HistoryPageMessage,
  ModelChoice,
  PermissionMode,
  PermissionModeOption,
  ProfileMetaUpdate,
  PortabilityApplyResult,
  PortabilityBundle,
  PortabilitySnapshot,
  ProfileValidation,
  RelayMessage,
  RemoteProfile,
  SessionSummary,
  SetCwdErrorCode,
} from "@/lib/relay/relay-types";
import type { Theme, ThemeValidationError } from "@/lib/theme/theme";
import { recordAvailableModels } from "@/lib/composer/modelCatalog";
import { authHeaders } from "@/lib/profiles/connectionResolver";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";
import { WS_PROTOCOL_VERSION } from "@/lib/relay/protocolVersion";

export type {
  AgentEvent,
  BackgroundJobSummary,
  ChoiceAnswer,
  ChoiceOption,
  ChoiceQuestion,
  ContextUsage,
  CreatedProfile,
  EditMessageErrorCode,
  HistoryMessage,
  HistoryPageMessage,
  ModelChoice,
  PermissionMode,
  PermissionModeOption,
  ProfileMetaUpdate,
  PortabilityApplyResult,
  PortabilityBundle,
  PortabilitySnapshot,
  ProfileValidation,
  RemoteProfile,
  SessionSummary,
  SetCwdErrorCode,
} from "@/lib/relay/relay-types";

function isRelayMessage(value: unknown): value is RelayMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

export async function fetchSessions(host: string, port: number, token?: string): Promise<SessionSummary[]> {
  const response = await fetch(`http://${host}:${port}/sessions`, { headers: authHeaders(token) });
  const body = (await response.json()) as { sessions?: SessionSummary[] };
  // `lastActiveAt` is normalized rather than trusted: a relay older than the
  // release that added it sends `{id, title}` only, and an `undefined` behind
  // a `number` type reaches the sidebar as a timestamp nothing can format.
  return (body.sessions ?? []).map((session) => ({
    ...session,
    lastActiveAt: typeof session.lastActiveAt === "number" ? session.lastActiveAt : null,
  }));
}

/** Manual rename (sidebar dialog) — works even for a session with no
 * tab open right now (the relay only needs the id, not a live WS connection). */
export async function renameSession(host: string, port: number, id: string, title: string, token?: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/sessions/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ id, title }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `failed to rename session (${String(response.status)})`);
  }
}

/** Only removes the session from anywh's control (sidebar, tabs) — doesn't delete the
 * transcript that Claude Code already keeps on its own. Works even for a
 * session with no tab open right now. */
export async function deleteSession(host: string, port: number, id: string, token?: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/sessions/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `failed to delete session (${String(response.status)})`);
  }
}

/** Actually closes a terminal tab (kills the tmux session, not just
 * detaches) — called when clicking the X on a terminal tab. See
 * terminalSession.ts for why this is a separate HTTP call instead
 * of a message on the terminal's own WS (the WS might already be closed
 * at this point, e.g. closing a tab that isn't the currently active one). */
export async function closeTerminal(host: string, port: number, session: string, term: string, token?: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/terminals/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ session, term }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `failed to close terminal (${String(response.status)})`);
  }
}

/** Every profile the given host's control API knows about — an
 * empty array both when the host genuinely has none and when the host
 * doesn't run the control API at all (an older relay, `GET /control/*`
 * 404s). Callers that need to tell those two apart should catch instead of
 * relying on the returned length; see `useProfileSync`, which is the only
 * caller and does exactly that. */
export async function fetchControlProfiles(host: string, port: number, token?: string): Promise<RemoteProfile[]> {
  const response = await fetch(`http://${host}:${port}/control/profiles`, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`failed to list profiles (${String(response.status)})`);
  }
  const body = (await response.json()) as { profiles?: RemoteProfile[] };
  return body.profiles ?? [];
}

/** Checks whether `homeOverride` (or the real `$HOME` if omitted) is
 * already logged into Claude Code, and whether it collides with a profile
 * this host already has. Always resolves with a body to interpret (`loggedIn`,
 * `collidesWith`) rather than throwing for those cases — only a genuine
 * failure to run the check (the relay's own 502) throws. */
export async function validateProfile(host: string, port: number, homeOverride?: string, runtimeId?: string): Promise<ProfileValidation> {
  const response = await fetch(`http://${host}:${port}/control/profiles/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(homeOverride ? { homeOverride } : {}), ...(runtimeId ? { runtimeId } : {}) }),
  });
  const body = (await response.json().catch(() => ({}))) as ProfileValidation & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `failed to validate profile (${String(response.status)})`);
  }
  return body;
}

/** Provisions a new profile on `host`'s relay (`.env` + `profiles.json` +
 * systemd instance — see `infra/systemd/add-profile.sh`). The relay
 * re-validates login/collision itself before provisioning, so a stale
 * `validateProfile` result from earlier in the dialog can't create a
 * profile that would actually fail. */
export async function createProfile(host: string, port: number, label: string, homeOverride?: string, runtimeId?: string): Promise<CreatedProfile> {
  const response = await fetch(`http://${host}:${port}/control/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, ...(homeOverride ? { home: homeOverride } : {}), ...(runtimeId ? { runtimeId } : {}) }),
  });
  const body = (await response.json().catch(() => ({}))) as CreatedProfile & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `failed to create profile (${String(response.status)})`);
  }
  return body;
}

/** What this host has configured for `runtimeId` that could be carried to
 * another config home — summary only (paths, sizes, declared MCP servers,
 * warnings), never file contents. `home` names the config home to read;
 * omitted, the relay reads its own profile's.
 *
 * A relay older than this endpoint 404s, which `AddProfileDialog` treats
 * as "nothing to offer" rather than an error: the checkbox simply doesn't
 * appear, which is the same thing the user sees on a machine that has
 * nothing configured. */
export async function fetchPortabilitySnapshot(host: string, port: number, runtimeId: string, home?: string): Promise<PortabilitySnapshot> {
  const params = new URLSearchParams({ runtime: runtimeId });
  if (home) params.set("home", home);
  const response = await fetch(`http://${host}:${port}/control/portability?${params.toString()}`);
  const body = (await response.json().catch(() => ({}))) as PortabilitySnapshot & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `failed to read configuration (${String(response.status)})`);
  return body;
}

/** The same read with contents included — asked for only once the user has
 * actually chosen to copy, since this is the call that moves the bytes. */
export async function fetchPortabilityBundle(host: string, port: number, runtimeId: string, home?: string): Promise<PortabilityBundle> {
  const params = new URLSearchParams({ runtime: runtimeId, full: "1" });
  if (home) params.set("home", home);
  const response = await fetch(`http://${host}:${port}/control/portability?${params.toString()}`);
  const body = (await response.json().catch(() => ({}))) as PortabilityBundle & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `failed to read configuration (${String(response.status)})`);
  return body;
}

/** Writes a bundle into `home` on the given host. Separate from the read
 * on purpose: the two ends are usually different machines, and the local
 * "second profile on this box" case is just the degenerate one where they
 * happen to be the same. */
export async function applyPortabilityBundle(
  host: string,
  port: number,
  bundle: PortabilityBundle,
  home?: string,
): Promise<PortabilityApplyResult> {
  const params = new URLSearchParams();
  if (home) params.set("home", home);
  const response = await fetch(`http://${host}:${port}/control/portability/apply?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  const body = (await response.json().catch(() => ({}))) as PortabilityApplyResult & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `failed to apply configuration (${String(response.status)})`);
  return body;
}

/** Renames/recolors/re-themes a profile on its own relay — safe to call on
 * the profile being edited (unlike `deleteProfile`): this only writes JSON,
 * it never touches the running process. `id` is immutable, never part of
 * the body. `themeId: null` clears the theme back to the built-in, which is
 * why it isn't just omitted. */
export async function updateProfileMeta(
  host: string,
  port: number,
  id: string,
  patch: { label?: string; colorIndex?: number; themeId?: string | null },
  token?: string,
): Promise<ProfileMetaUpdate> {
  const response = await fetch(`http://${host}:${port}/control/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const body = (await response.json().catch(() => ({}))) as ProfileMetaUpdate & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `failed to update profile (${String(response.status)})`);
  }
  return body;
}

/** Every custom theme registered on this host. Host-wide, not per-profile:
 * the same theme is selectable from any profile on the machine
 * (relay/src/themeRegistry.ts). Throws on an older relay that doesn't have
 * the route, which is how `useThemeSync` tells "no custom themes" apart
 * from "this host can't store them". */
export async function fetchThemes(host: string, port: number, token?: string): Promise<Theme[]> {
  const response = await fetch(`http://${host}:${port}/control/themes`, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`failed to list themes (${String(response.status)})`);
  }
  const body = (await response.json()) as { themes?: Theme[] };
  return body.themes ?? [];
}

/** Creates or overwrites a theme on `host`. The relay revalidates and, on a
 * broken file, answers with one error per field — surfaced here as
 * `ThemeSaveError.errors` so the import UI can point at the offending line
 * instead of showing one flat message. */
export async function saveTheme(host: string, port: number, theme: Theme, token?: string): Promise<Theme> {
  const response = await fetch(`http://${host}:${port}/control/themes/${encodeURIComponent(theme.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(theme),
  });
  const body = (await response.json().catch(() => ({}))) as Theme & {
    error?: string;
    errors?: ThemeValidationError[];
  };
  if (!response.ok) {
    throw new ThemeSaveError(body.error ?? `failed to save theme (${String(response.status)})`, body.errors ?? []);
  }
  return body;
}

export class ThemeSaveError extends Error {
  constructor(
    message: string,
    readonly errors: ThemeValidationError[],
  ) {
    super(message);
    this.name = "ThemeSaveError";
  }
}

/** Removes a theme from the host registry. Profiles still pointing at it
 * keep the dangling `themeId` on purpose (see themeRegistry.ts) — they fall
 * back to the built-in theme and recover the choice if it's added back. */
export async function deleteTheme(host: string, port: number, id: string, token?: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/control/themes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `failed to delete theme (${String(response.status)})`);
  }
}

/** Deletes a profile from the host's registry (`.env` + `profiles.json` +
 * systemd instance) — `host`/`port` here must be a *different* profile's
 * relay than `id`, never `id`'s own (it would have to
 * disable its own systemd instance mid-request). Picking a safe executor is
 * the caller's job — see `SettingsDialog`'s "Excluir do servidor". */
export async function deleteProfile(host: string, port: number, id: string): Promise<void> {
  const response = await fetch(`http://${host}:${port}/control/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `failed to delete profile (${String(response.status)})`);
  }
}

export interface RelayClientCallbacks {
  /** Every `AgentEvent` of the session's log, EXCEPT `turn_ended`/`error` —
   * those two are turn lifecycle, folded into the same `agent_event` wire
   * message but split back out into `onTurnComplete`/`onTurnError` below,
   * the same two callbacks that existed before the fold. `turn_started` DOES
   * come through here — nothing distinguishes it from any other event this
   * callback doesn't act on yet. */
  onEvent: (event: AgentEvent) => void;
  onTurnComplete: (stopped: boolean) => void;
  onTurnError: (message: string) => void;
  /** End of this session's history replay — completed turns received
   * after this are truly new, not reconstruction (see sharedSession.ts). */
  onCaughtUp: () => void;
  /** Sent right on connection (before history replay) and again every
   * time the working directory changes or locks — see sharedSession.ts. */
  onCwdState: (cwd: string, locked: boolean) => void;
  onSetCwdError?: (code: SetCwdErrorCode) => void;
  /** Sent right on connection (before cwd_state's siblings) and again on
   * `switchAgent` — see sharedSession.ts. Drives `AgentPickerButton`'s
   * current selection and the `ModelButton` gate (Composer.tsx). */
  onAgentState: (agentId: string) => void;
  /** Sent right on connection (before the replay) and again every time the mode
   * changes — see sharedSession.ts::setPermissionMode. `available` is this
   * session's own agent's mode vocabulary (session/permissionModes.ts on the
   * relay) — defaults to `[]` for a client one build behind a relay that
   * doesn't send it yet, same "hasn't arrived" reading `PermissionModeButton`
   * already gives an empty list. */
  onPermissionModeState: (mode: PermissionMode, available: PermissionModeOption[]) => void;
  /** Sent right on connection and again every time the model changes — see
   * sharedSession.ts::setModel. `null` is a valid final state ("never
   * chosen via /model, uses the CLI default"), not "still loading". */
  onModelState: (model: ModelChoice | null) => void;
  /** This profile's account's actual default model — sent
   * as soon as the relay finishes probing at boot (may arrive before or after
   * the connection opens), doesn't change after that for the life of the process. */
  onDefaultModelState?: (label: string, available: ModelChoice[]) => void;
  /** Sent right on connection (if there's already a completed turn in this
   * session) and again at the end of every turn that produced context usage —
   * see sharedSession.ts::broadcastContextUsage. `null` after a
   * `/clear` (see onConversationReset). */
  onContextUsageState?: (usage: ContextUsage | null) => void;
  /** Turn in progress on the session (not just from whoever sent it) — sent right on
   * connection and again every time a turn starts/ends, from any
   * device. See relay-types.ts::RelayMessage["turn_state"]. */
  onTurnState?: (state: { active: boolean; startedAt?: number }) => void;
  /** Suggested next message arriving (live or right on connection) —
   * see relay-types.ts::RelayMessage["suggestion"]. `null` clears any
   * suggestion shown. */
  onSuggestion?: (text: string | null) => void;
  /** `/clear` — this session's conversation was reset (by this
   * device or another); whoever consumes this should clear the local
   * message log, same idea as the `reset()` already used in `onReconnecting`. */
  onConversationReset?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Title inferred from the first prompt (or from a manual rename done on
   * another device) arriving live — see sharedSession.ts::setTitle. */
  onSessionTitle?: (title: string) => void;
  /** Session deleted (by this device or another) — see
   * sharedSession.ts::closeAllClients. The socket closes shortly after. */
  onSessionDeleted?: () => void;
  /** Fired right before reopening the connection (automatic backoff or
   * `forceReconnect`) — never on the first connection. The relay resends the
   * entire history on every new connection (`SharedSession.addClient`), so
   * whoever consumes this should reset the message log here, otherwise the replay
   * duplicates everything on top of what was already on screen. */
  onReconnecting?: () => void;
  /** The broker told us this device's own identity was deliberately revoked
   * — a terminal state, not a connectivity blip. Fired once
   * per revoked token-fetch attempt, no automatic reconnect follows;
   * whoever consumes this should stop showing "reconnecting" and offer to
   * remove the profile instead. */
  onRevoked?: () => void;
  /** The relay just announced a `WS_PROTOCOL_VERSION` this build doesn't
   * match — also terminal, same treatment as `onRevoked`: no automatic
   * reconnect follows (retrying would just hit the same mismatch again),
   * and whoever consumes this should tell the user to update the app
   * instead of showing "reconnecting". `relayVersion` is whatever the relay
   * announced, for a message that can name the actual gap. */
  onProtocolMismatch?: (relayVersion: number) => void;
  /** Recent tail of this session's history — sent once per connection,
   * right before `onCaughtUp`. Optional only during the
   * migration: whoever doesn't yet hydrate the log in bulk simply
   * ignores it and keeps seeing an empty log until that phase exists. */
  onHistoryPage?: (page: HistoryPageMessage) => void;
  /** Response to `loadOlderHistory` — turns older
   * than the initial tail, requested on demand (scroll up). */
  onOlderHistory?: (page: HistoryPageMessage) => void;
  /** `anywh-bg` jobs currently observed in the session — sent right on connection
   * (even an empty array, if there are none) and again whenever the list
   * changes, from any device. */
  onBackgroundJobState?: (jobs: BackgroundJobSummary[]) => void;
  /** Message edit — arrives only on the OTHER devices
   * connected to the session, syncing the cut point before the
   * edited turn starts streaming. Same handling as `onReconnecting` +
   * `onHistoryPage`: whoever consumes this resets the log and hydrates with this page. */
  onHistoryTruncated?: (page: HistoryPageMessage) => void;
  /** `edit_message` that was invalid or failed to truncate the real transcript —
   * arrives only for whoever requested the edit. */
  onEditMessageError?: (code: EditMessageErrorCode) => void;
  /** Sent right on connection (before the replay) and again every time the
   * draft changes, from any device — see sharedSession.ts::setDraft. Lets a
   * reopened/restarted app restore what was typed but not yet sent. */
  onDraftState: (draft: string) => void;
  /** The model called `present_choice` mid-turn and is genuinely
   * blocked waiting for an answer. "Current state" pattern, same as
   * `onCwdState`/`onTurnState`: sent again to a device that (re)connects
   * mid-wait, not just to whoever was already there. Answer via
   * `RelayClient.answerChoice`. */
  onChoicePrompt?: (promptId: string, questions: ChoiceQuestion[], kind: "approval" | "choice") => void;
  /** The prompt above was answered (by any device) or the turn that asked
   * it ended before anyone answered — whoever shows it should dismiss it. */
  onChoiceResolved?: (promptId: string) => void;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Floor for the one refusal that retrying quickly actively makes worse: the
// broker told us it is throttling this account (429). The normal backoff
// starts at half a second, which is the wrong answer to "you are asking too
// often" — and to "this account is out of compute", where nothing changes
// until the user does something about it somewhere else entirely.
const THROTTLED_RECONNECT_DELAY_MS = 60_000;
// Same pace for a machine that is simply asleep, and for the same reason:
// what brings it back is the user returning (which arrives as
// `forceReconnect`, jumping this timer), not the next tick.
const ASLEEP_RECONNECT_DELAY_MS = 60_000;

export class RelayClient {
  private socket?: WebSocket;
  /** Folder chosen (e.g. via `WorkingDirectoryButton` on a new conversation)
   * before the socket opens — there's no outgoing queue, only the last choice
   * matters. Sent as soon as the connection opens; see `connect`. */
  private pendingCwd: string | null = null;
  /** Same logic as `pendingCwd` — only the last choice before the socket
   * opens matters. */
  private pendingPermissionMode: PermissionMode | null = null;
  /** Same logic as `pendingCwd` — a picked-before-connecting agent is sent
   * once the socket opens. */
  private pendingAgent: string | null = null;
  /** Same logic as `pendingCwd` — only the latest debounced value before the
   * socket opens matters, no queue of intermediate keystrokes. */
  private pendingDraft: string | null = null;
  /** `false` only after a deliberate `disconnect()` (tab/session switch) —
   * while `true`, every unexpected `close` schedules a new attempt. */
  private shouldReconnect = true;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  /** Counts every `connect()` call, including the first — used only to
   * know whether a reconnection is in progress (`> 1`), so as not to fire
   * `onReconnecting` on the initial connection. */
  private connectCount = 0;
  /** Bumped by every `connect()` — a token resolved for an attempt that has
   * since been superseded (or cancelled by `disconnect`) must not open a
   * socket when it finally arrives. */
  private connectGeneration = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly sessionId: string,
    private readonly callbacks: RelayClientCallbacks,
    /** See `Profile.connectToken` — sent as a query param because the
     * browser `WebSocket` constructor has no way to set a header. A plain
     * string for a fixed credential (a reverse proxy gating access); a
     * resolver for a brokered profile, whose token authorizes exactly one
     * handshake and so has to be re-fetched for every
     * attempt, reconnections included. */
    private readonly connectToken?: string | ((options: { wake: boolean }) => Promise<string>),
  ) {}

  /** Whether the *next* `connect()` may wake a sleeping machine. True for
   * anything a person did — the first connection, and `forceReconnect` when
   * they come back to the app — false for a reconnect a timer scheduled,
   * whose most likely cause is the machine having gone to sleep because
   * nobody was using it. Waking it there is a loop with no one in it. */
  private nextConnectWakes = true;

  connect(): void {
    this.connectCount += 1;
    this.connectGeneration += 1;
    if (this.connectCount > 1) this.callbacks.onReconnecting?.();

    if (typeof this.connectToken !== "function") {
      this.openSocket(this.connectToken);
      return;
    }
    const generation = this.connectGeneration;
    const wake = this.nextConnectWakes;
    this.nextConnectWakes = true;
    void this.connectToken({ wake }).then(
      (token) => {
        // A newer attempt started (or `disconnect` ran) while this token was
        // being fetched — the token is simply dropped, unspent.
        if (generation !== this.connectGeneration || !this.shouldReconnect) return;
        this.openSocket(token);
      },
      (err: unknown) => {
        if (generation !== this.connectGeneration) return;
        if (err instanceof BrokerRevokedError) {
          // Terminal, not transient — retrying would just repeat the same
          // 410 forever, which is exactly the "reconnecting" loop with no
          // way out that this distinction exists to break.
          console.error("connection token permanently rejected:", err);
          this.shouldReconnect = false;
          this.callbacks.onRevoked?.();
          return;
        }
        if (err instanceof BrokerThrottledError) {
          console.error("connection token refused, backing off:", err);
          this.scheduleReconnect(Math.max(err.retryAfterMs ?? 0, THROTTLED_RECONNECT_DELAY_MS));
          return;
        }
        if (err instanceof BrokerAsleepError) {
          // Expected, not a failure: this attempt deliberately declined to
          // wake the machine. Keep a slow retry so the tab reattaches by
          // itself if something else brings it up.
          this.scheduleReconnect(ASLEEP_RECONNECT_DELAY_MS);
          return;
        }
        // Same treatment as a socket that failed to open: the broker being
        // unreachable is as transient as the relay being unreachable.
        console.error("failed to resolve a connection token:", err);
        this.scheduleReconnect();
      },
    );
  }

  private openSocket(token: string | undefined): void {
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
    const socket = new WebSocket(
      `ws://${this.host}:${this.port}/?session=${encodeURIComponent(this.sessionId)}${tokenParam}`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.callbacks.onConnectionChange?.(true);
      if (this.pendingCwd !== null) {
        const path = this.pendingCwd;
        this.pendingCwd = null;
        socket.send(JSON.stringify({ type: "set_cwd", path }));
      }
      if (this.pendingPermissionMode !== null) {
        const mode = this.pendingPermissionMode;
        this.pendingPermissionMode = null;
        socket.send(JSON.stringify({ type: "set_permission_mode", mode }));
      }
      if (this.pendingAgent !== null) {
        const agentId = this.pendingAgent;
        this.pendingAgent = null;
        socket.send(JSON.stringify({ type: "set_agent", agentId }));
      }
      if (this.pendingDraft !== null) {
        const draft = this.pendingDraft;
        this.pendingDraft = null;
        socket.send(JSON.stringify({ type: "set_draft", draft }));
      }
    });
    socket.addEventListener("close", () => {
      // Late event from a socket that `forceReconnect`/automatic reconnection
      // already replaced — ignore it, otherwise it signals disconnected over a
      // new connection that may already be open.
      if (this.socket !== socket) return;
      this.callbacks.onConnectionChange?.(false);
      this.scheduleReconnect();
    });
    socket.addEventListener("message", (event) => {
      const parsed: unknown = JSON.parse(event.data as string);
      if (!isRelayMessage(parsed)) return;

      if (parsed.type === "protocol_version") {
        if (parsed.version !== WS_PROTOCOL_VERSION) {
          console.error(`relay speaks protocol v${String(parsed.version)}, this build speaks v${String(WS_PROTOCOL_VERSION)}`);
          this.shouldReconnect = false;
          this.callbacks.onProtocolMismatch?.(parsed.version);
          socket.close();
        }
      } else if (parsed.type === "agent_event") {
        if (parsed.event.type === "turn_ended") {
          this.callbacks.onTurnComplete(parsed.event.stopped);
        } else if (parsed.event.type === "error") {
          this.callbacks.onTurnError(parsed.event.message);
        } else {
          this.callbacks.onEvent(parsed.event);
        }
      } else if (parsed.type === "caught_up") {
        this.callbacks.onCaughtUp();
      } else if (parsed.type === "cwd_state") {
        this.callbacks.onCwdState(parsed.cwd, parsed.locked);
      } else if (parsed.type === "agent_state") {
        this.callbacks.onAgentState(parsed.agentId);
      } else if (parsed.type === "set_cwd_error") {
        this.callbacks.onSetCwdError?.(parsed.code);
      } else if (parsed.type === "session_title") {
        this.callbacks.onSessionTitle?.(parsed.title);
      } else if (parsed.type === "session_deleted") {
        this.callbacks.onSessionDeleted?.();
      } else if (parsed.type === "draft_state") {
        this.callbacks.onDraftState(parsed.draft);
      } else if (parsed.type === "permission_mode_state") {
        this.callbacks.onPermissionModeState(parsed.mode, parsed.available ?? []);
      } else if (parsed.type === "model_state") {
        this.callbacks.onModelState(parsed.model);
      } else if (parsed.type === "default_model_state") {
        recordAvailableModels(parsed.available);
        this.callbacks.onDefaultModelState?.(parsed.label, parsed.available);
      } else if (parsed.type === "context_usage_state") {
        this.callbacks.onContextUsageState?.(parsed.usage);
      } else if (parsed.type === "turn_state") {
        this.callbacks.onTurnState?.({ active: parsed.active, startedAt: parsed.startedAt });
      } else if (parsed.type === "conversation_reset") {
        this.callbacks.onConversationReset?.();
      } else if (parsed.type === "suggestion") {
        this.callbacks.onSuggestion?.(parsed.text);
      } else if (parsed.type === "history_page") {
        this.callbacks.onHistoryPage?.(parsed);
      } else if (parsed.type === "older_history") {
        this.callbacks.onOlderHistory?.(parsed);
      } else if (parsed.type === "background_job_state") {
        this.callbacks.onBackgroundJobState?.(parsed.jobs);
      } else if (parsed.type === "history_truncated") {
        this.callbacks.onHistoryTruncated?.(parsed);
      } else if (parsed.type === "edit_message_error") {
        this.callbacks.onEditMessageError?.(parsed.code);
      } else if (parsed.type === "choice_prompt") {
        this.callbacks.onChoicePrompt?.(parsed.promptId, parsed.questions, parsed.kind);
      } else if (parsed.type === "choice_resolved") {
        this.callbacks.onChoiceResolved?.(parsed.promptId);
      }
    });
  }

  sendMessage(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "user_message", text }));
  }

  stopTurn(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "stop_turn" }));
  }

  /** Message edit — `fromEnd` counts from the end (`1` = the
   * user's last message). The relay stops the current turn (if any),
   * cuts the real transcript at the right point, and runs a new turn with `text`.
   * No pending queue (same reasoning as `setModel`): it only makes sense to
   * call this after at least one message has already been rendered, which
   * means the socket is already open. */
  editMessage(fromEnd: number, text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "edit_message", fromEnd, text }));
  }

  setCwd(path: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      // A new conversation tab allows choosing the folder before the connection opens
      // (see WorkingDirectoryButton) — stores it and sends it as soon as it opens, instead
      // of simply discarding the user's choice.
      this.pendingCwd = path;
      return;
    }
    this.socket.send(JSON.stringify({ type: "set_cwd", path }));
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.pendingPermissionMode = mode;
      return;
    }
    this.socket.send(JSON.stringify({ type: "set_permission_mode", mode }));
  }

  setAgent(agentId: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.pendingAgent = agentId;
      return;
    }
    this.socket.send(JSON.stringify({ type: "set_agent", agentId }));
  }

  setDraft(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.pendingDraft = text;
      return;
    }
    this.socket.send(JSON.stringify({ type: "set_draft", draft: text }));
  }

  /** No "pending before connecting" queue (unlike `setCwd`/
   * `setPermissionMode`): only triggered via `/model` typed in the composer,
   * which is already disabled while `!connected` — there's never a way to call
   * this before the socket opens. */
  setModel(model: ModelChoice): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "set_model", model }));
  }

  /** `/clear` — same reasoning as `setModel` about not needing
   * a pending queue. */
  clearConversation(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "clear_conversation" }));
  }

  /** Asks the relay to compute (or hand back a cached) context breakdown —
   * sent once, when the context usage popover first opens. No "pending
   * before connecting" queue, same reasoning as `setModel`: this can only
   * ever be triggered by clicking a chip that itself requires a connected
   * session with an existing `contextUsage` to be visible at all. */
  requestContextBreakdown(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "request_context_breakdown" }));
  }

  /** Fetches turns older than `beforeCursor` —
   * triggered by the user scrolling up in the UI. Same reasoning
   * as `setModel` about not needing a pending queue: it only makes sense to
   * call this after the initial tail has already arrived (`onHistoryPage`), so the
   * socket is always already open at this point. */
  loadOlderHistory(beforeCursor: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "load_older_history", beforeCursor }));
  }

  /** Cancels an `anywh-bg` job from the UI — same reasoning
   * as `setModel`/`clearConversation` about not needing a pending
   * queue: the chip that exposes this only appears when a job already exists in the
   * list, which means `background_job_state` has already arrived, which
   * means the socket is already open. */
  cancelBackgroundJob(id: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "cancel_background_job", id }));
  }

  /** Answers a pending `present_choice` prompt. Same reasoning as
   * `setModel`/`clearConversation` about not needing a pending queue: the
   * picker that exposes this only appears once `onChoicePrompt` already
   * fired, which means the socket is already open. */
  answerChoice(promptId: string, answers: ChoiceAnswer[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "choice_answer", promptId, answers }));
  }

  disconnect(): void {
    this.shouldReconnect = false;
    // Invalidates any token still being resolved for an attempt in flight —
    // `shouldReconnect` alone already covers it, this keeps the two paths
    // (superseded vs. cancelled) from having to be reasoned about apart.
    this.connectGeneration += 1;
    this.clearReconnectTimer();
    this.socket?.close();
  }

  /** Called when returning from background/foreground — doesn't
   * trust the native `close` timing, which may never fire on a
   * "zombie" socket (`readyState` still `OPEN` but the network connection has really
   * already died). Only reconnects if the socket isn't genuinely usable;
   * a healthy connection is left untouched (spike 3 showed that sockets
   * usually survive a short background period with no intervention at all). */
  forceReconnect(): void {
    const state = this.socket?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    this.clearReconnectTimer();
    // The user is back in front of the app — the one reconnect that is
    // allowed to bring a sleeping machine up, and the reason the background
    // ones don't have to.
    this.nextConnectWakes = true;
    this.connect();
  }

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (!this.shouldReconnect) return;
    // Every reconnect this schedules is by definition not a person's doing.
    this.nextConnectWakes = false;
    const delay = delayOverrideMs ?? Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
