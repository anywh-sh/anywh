import { useCallback, useEffect, useRef, useState } from "react";
import {
  RelayClient,
  type AgentEvent,
  type BackgroundJobSummary,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type ContextUsage,
  type EditMessageErrorCode,
  type HistoryPageMessage,
  type ModelChoice,
  type PermissionMode,
  type RelayClientCallbacks,
  type SetCwdErrorCode,
} from "@/lib/relay/relayClient";
import { isBrokeredProfile, isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { acquireTailnetSidecar, releaseTailnetSidecar } from "@/lib/profiles/tailnetSidecar";
import { BrokerRevokedError, fetchConnectGrant } from "@/lib/profiles/tailnetBroker";
import { markProfileRevoked } from "@/lib/profiles/profileRevocation";

/** A received `compact_boundary`, with a timestamp — the timestamp guarantees a
 * fresh reference on every occurrence (even with repeated `trigger`/`preTokens`),
 * so whoever shows a toast can react via `useEffect` without needing to
 * tell the hook back that it already showed it. */
export interface CompactBoundaryEvent {
  trigger: "auto" | "manual";
  preTokens: number;
  receivedAt: number;
}

/** A `present_choice` prompt currently blocked waiting for an
 * answer, if any. See `RelayClientCallbacks.onChoicePrompt`. */
export interface PendingChoice {
  promptId: string;
  questions: ChoiceQuestion[];
  /** See the `choice_prompt` doc comment in relay-types.ts — `"approval"` is
   * a live blocked tool call, `"choice"` a deferred prompt that can be
   * closed with no answer at all. */
  kind: "approval" | "choice";
}

export interface UseRelayClientOptions {
  onEvent?: (event: AgentEvent) => void;
  onTurnComplete?: (stopped: boolean) => void;
  onTurnError?: (message: string) => void;
  onCaughtUp?: () => void;
  onSetCwdError?: (code: SetCwdErrorCode) => void;
  onSessionTitle?: (title: string) => void;
  onSessionDeleted?: () => void;
  /** See `RelayClientCallbacks.onReconnecting` — fires before any
   * history replay that isn't from the initial connection. */
  onReconnecting?: () => void;
  /** `/clear` — see `RelayClientCallbacks.onConversationReset`. */
  onConversationReset?: () => void;
  /** Turn in progress on the session, not just from whoever sent it — see
   * `RelayClientCallbacks.onTurnState`. Pure passthrough: `ChatPanel`
   * already keeps its own `turnStartedAt`, no need for duplicated state here. */
  onTurnState?: (state: { active: boolean; startedAt?: number }) => void;
  /** Recent tail of this session's history — see
   * `RelayClientCallbacks.onHistoryPage`. */
  onHistoryPage?: (page: HistoryPageMessage) => void;
  /** Response to `loadOlderHistory` — see `RelayClientCallbacks.onOlderHistory`. */
  onOlderHistory?: (page: HistoryPageMessage) => void;
  /** Message edit on ANOTHER device connected to the session —
   * see `RelayClientCallbacks.onHistoryTruncated`. */
  onHistoryTruncated?: (page: HistoryPageMessage) => void;
  /** `edit_message` requested by this device failed — see
   * `RelayClientCallbacks.onEditMessageError`. */
  onEditMessageError?: (code: EditMessageErrorCode) => void;
}

export interface UseRelayClientResult {
  connected: boolean;
  /** `true` while a tailnet-mode profile's sidecar is joining the tailnet,
   * before the relay `WebSocket` even starts connecting —
   * always `false` for a direct-mode profile, which has no such step. Purely
   * informational: no UI reads it yet (cosmetic, out of scope for now). */
  connectingTailnet: boolean;
  /** `null` only in the brief window between connecting and the first `cwd_state`
   * arriving — see `SharedSession.addClient` on the relay, which sends this before
   * anything else. */
  cwd: string | null;
  cwdLocked: boolean;
  /** `null` only in the brief window between connecting and the first
   * `permission_mode_state` arriving — same reason as `cwd` above. */
  permissionMode: PermissionMode | null;
  /** `null` both in the brief window between connecting and the first `model_state`
   * and in the final "never chosen via /model" state — the two
   * behave the same for the UI (uses the CLI default), no need to distinguish. */
  model: ModelChoice | null;
  /** The actual default model for this profile's account — display
   * fallback for when `model` above is `null`. `null` only in the brief window
   * before the relay's probe finishes (or if it fails). */
  defaultModel: string | null;
  /** `null` until the first `context_usage_state` arrives — never arrives for a
   * new session with no completed turn yet (see sharedSession.ts), and
   * goes back to `null` after a `/clear`. */
  contextUsage: ContextUsage | null;
  /** The relay announced a `WS_PROTOCOL_VERSION` this build doesn't match —
   * terminal, same shape as `useProfileRevoked`: no reconnect is coming, the
   * only way out is updating the app. `null` in the overwhelmingly common
   * case (matching versions, or not resolved yet). */
  protocolMismatch: number | null;
  /** Last `compact_boundary` seen, if any — meant for a transient toast
   * in the UI, not persistent state (see `CompactBoundaryEvent`). */
  compactBoundary: CompactBoundaryEvent | null;
  /** Suggested next message, if any — see relay-types.ts. `null`
   * for both "no suggestion yet" and "previous suggestion no longer valid". */
  suggestion: string | null;
  /** Clears the suggestion locally only (no round-trip) — the relay will already clear
   * its own and broadcast `null` as soon as the corresponding `submitTurn`
   * arrives, but that has network latency; whoever sends a message already
   * knows the current suggestion is no longer valid, so this is called right away
   * to avoid the risk of the old placeholder reappearing for a fraction of a
   * second after the composer is cleared (same spirit as the optimistic
   * update of `onActivity` in ChatPanel). */
  dismissSuggestion: () => void;
  sendMessage: (text: string) => void;
  stopTurn: () => void;
  setCwd: (path: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setModel: (model: ModelChoice) => void;
  clearConversation: () => void;
  /** Fetches turns older than `beforeCursor` — see
   * `RelayClient.loadOlderHistory`. */
  loadOlderHistory: (beforeCursor: number) => void;
  /** `anywh-bg` jobs currently observed in this session — empty array (never
   * `null`) for both "no job" and "the first
   * `background_job_state` hasn't arrived yet": the two don't have
   * different UI (indicator hidden in both cases), no need to distinguish. */
  backgroundJobs: BackgroundJobSummary[];
  /** Asks the relay to kill an in-progress `anywh-bg` job —
   * `background_job_state` disappears from the list as soon as the relay processes it,
   * with no separate confirmation (the job disappearing from the chip is itself the signal). */
  cancelBackgroundJob: (id: string) => void;
  /** Message edit — see `RelayClient.editMessage`. */
  editMessage: (fromEnd: number, text: string) => void;
  /** Composer text not yet sent, persisted per tab so it survives an app
   * crash/restart — see `RelayClientCallbacks.onDraftState`. `null` only in
   * the brief window between connecting and the first `draft_state`
   * arriving, same reasoning as `cwd`/`permissionMode` above. */
  draft: string | null;
  setDraft: (text: string) => void;
  /** A `present_choice` prompt currently blocked waiting for an
   * answer, `null` when there's none. */
  choicePrompt: PendingChoice | null;
  /** Answers the current `choicePrompt` — a no-op if it's already `null`
   * (e.g. the turn ended and resolved it right as the user was answering). */
  answerChoice: (answers: ChoiceAnswer[]) => void;
}

/**
 * One instance per open tab — including background tabs, which stay
 * mounted (see TabGroupLayout's flat panel layer) to keep the WebSocket alive even without
 * focus. Callback-based: the caller decides where events
 * end up (e.g. the `useMessageLog` reducer) instead of the hook accumulating its
 * own duplicated array.
 */
export function useRelayClient(
  profile: Profile,
  sessionId: string,
  options: UseRelayClientOptions = {},
): UseRelayClientResult {
  const [connected, setConnected] = useState(false);
  const [connectingTailnet, setConnectingTailnet] = useState(false);
  const [cwd, setCwdState] = useState<string | null>(null);
  const [cwdLocked, setCwdLocked] = useState(false);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode | null>(null);
  const [model, setModelState] = useState<ModelChoice | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [protocolMismatch, setProtocolMismatch] = useState<number | null>(null);
  const [compactBoundary, setCompactBoundary] = useState<CompactBoundaryEvent | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [backgroundJobs, setBackgroundJobs] = useState<BackgroundJobSummary[]>([]);
  const [draft, setDraftState] = useState<string | null>(null);
  const [choicePrompt, setChoicePrompt] = useState<PendingChoice | null>(null);
  const clientRef = useRef<RelayClient | null>(null);
  const choicePromptRef = useRef(choicePrompt);
  choicePromptRef.current = choicePrompt;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    // Working directory state is per connection — switching tab/session
    // reconnects from scratch, so it starts "unknown" until the relay sends the
    // first `cwd_state` for this new session.
    setCwdState(null);
    setCwdLocked(false);
    setPermissionModeState(null);
    setModelState(null);
    setDefaultModel(null);
    setContextUsage(null);
    setProtocolMismatch(null);
    setCompactBoundary(null);
    setSuggestion(null);
    setBackgroundJobs([]);
    setDraftState(null);
    setChoicePrompt(null);

    const tailnetMode = isTailnetProfile(profile);
    setConnectingTailnet(tailnetMode);

    let cancelled = false;
    // Whether this effect run holds a reference on the profile's sidecar —
    // the cleanup below must only release one it actually took. `start()` is
    // deferred and can be cancelled before ever reaching the acquire (or
    // bail out earlier, on a broker failure), and the sidecar is shared
    // between every tab open on the same profile: an unpaired release
    // decrements *another* tab's reference and tears down the tailnet join
    // out from under it.
    let acquiredSidecar = false;
    const callbacks: RelayClientCallbacks = {
      onEvent: (event) => {
        // `compact_boundary` passes through the generic `AgentEvent` stream
        // with no special treatment on the relay — this only intercepts it
        // here to feed the toast, without removing the event from the
        // normal flow (useMessageLog etc. keep receiving everything as before).
        if (event.type === "compact_boundary") {
          setCompactBoundary({ trigger: event.trigger, preTokens: event.preTokens, receivedAt: Date.now() });
        }
        optionsRef.current.onEvent?.(event);
      },
      onTurnComplete: (stopped) => optionsRef.current.onTurnComplete?.(stopped),
      onTurnError: (message) => optionsRef.current.onTurnError?.(message),
      onCaughtUp: () => optionsRef.current.onCaughtUp?.(),
      onCwdState: (newCwd, locked) => {
        setCwdState(newCwd);
        setCwdLocked(locked);
      },
      onSetCwdError: (code) => optionsRef.current.onSetCwdError?.(code),
      onPermissionModeState: setPermissionModeState,
      onModelState: setModelState,
      onDefaultModelState: setDefaultModel,
      onContextUsageState: setContextUsage,
      onSuggestion: setSuggestion,
      onSessionTitle: (title) => optionsRef.current.onSessionTitle?.(title),
      onSessionDeleted: () => optionsRef.current.onSessionDeleted?.(),
      onConnectionChange: setConnected,
      onReconnecting: () => optionsRef.current.onReconnecting?.(),
      onRevoked: () => markProfileRevoked(profile.id),
      onProtocolMismatch: setProtocolMismatch,
      onConversationReset: () => optionsRef.current.onConversationReset?.(),
      onHistoryPage: (page) => optionsRef.current.onHistoryPage?.(page),
      onOlderHistory: (page) => optionsRef.current.onOlderHistory?.(page),
      onTurnState: (state) => optionsRef.current.onTurnState?.(state),
      onBackgroundJobState: setBackgroundJobs,
      onHistoryTruncated: (page) => optionsRef.current.onHistoryTruncated?.(page),
      onEditMessageError: (message) => optionsRef.current.onEditMessageError?.(message),
      onDraftState: setDraftState,
      onChoicePrompt: (promptId, questions, kind) => setChoicePrompt({ promptId, questions, kind }),
      // Only clears local state if it's still the SAME prompt — a new one
      // could in principle already be pending by the time this arrives
      // (unlikely given only one `present_choice` call is ever in flight per
      // session, but cheap to guard against a stale resolve clobbering it).
      onChoiceResolved: (promptId) => {
        if (choicePromptRef.current?.promptId === promptId) setChoicePrompt(null);
      },
    };

    async function start(): Promise<void> {
      let host = profile.host;
      let port = profile.relayPort;
      let wsToken: string | ((options: { wake: boolean }) => Promise<string>) | undefined = profile.connectToken;
      if (tailnetMode) {
        try {
          // A brokered profile resolves the target and a
          // fresh handshake token from the broker on every connection
          // (never reuses one); a profile with only the static
          // fields dials `tailnetTarget` and keeps using its stored
          // `connectToken`, same as before brokered profiles existed.
          let target = profile.tailnetTarget;
          if (isBrokeredProfile(profile)) {
            const grant = await fetchConnectGrant(profile);
            if (cancelled) return;
            target = `${grant.endpoint.host}:${String(grant.endpoint.port)}`;
            // Same anti-replay reasoning again, on the reconnection side: the grant fetched just
            // now opens the first connection, and every attempt after it
            // (the proxy spends a token's `jti` on the handshake, so
            // resending this one loops on "reconnecting" forever) resolves
            // its own.
            let firstToken: string | undefined = grant.token;
            wsToken = async ({ wake }) => {
              if (firstToken !== undefined) {
                const token = firstToken;
                firstToken = undefined;
                return token;
              }
              // `wake` comes from RelayClient: true when the user drove this
              // attempt, false for a reconnect a timer scheduled.
              return (await fetchConnectGrant(profile, { wake })).token;
            };
          }
          if (!target) throw new Error("tailnet profile has no target to dial (no tailnetTarget and no broker)");
          // Flagged synchronously with the call, before the first await:
          // the reference is taken the moment `acquireTailnetSidecar`
          // runs, so a cleanup landing while the join is still in flight
          // has to see it.
          const acquisition = acquireTailnetSidecar(profile, target);
          acquiredSidecar = true;
          const endpoint = await acquisition;
          if (cancelled) return;
          host = endpoint.host;
          port = endpoint.port;
        } catch (err) {
          console.error("tailnet-sidecar failed to join the tailnet:", err);
          // Same terminal signal as `onRevoked` below, but for the very
          // first connection attempt — this catch runs before `RelayClient`
          // even exists, so there's no reconnect loop to stop, just the
          // same "tell the banner" step.
          if (err instanceof BrokerRevokedError) markProfileRevoked(profile.id);
          return;
        } finally {
          if (!cancelled) setConnectingTailnet(false);
        }
      }
      const client = new RelayClient(host, port, sessionId, callbacks, wsToken);
      clientRef.current = client;
      client.connect();
    }
    // Deferred by a tick, same trick as tailnetSidecar.ts's release delay
    // and for the same reason: React 18 StrictMode (dev) mounts this
    // effect, cleans it up, and mounts it again, synchronously, within one
    // tick. `start()`'s first await is `fetchConnectGrant` — a broker call
    // signed with a fresh timestamp that the control plane accepts exactly
    // once (its anti-replay check). Calling it straight from the
    // effect meant the doomed first mount's `start()` already ran past that
    // await (and so had already sent its signed request) by the time its
    // own cleanup set `cancelled` — both mounts' requests reached the
    // server, and whichever one happened to land in the same millisecond as
    // the other got rejected as a replay, sometimes taking down the mount
    // that mattered. `setTimeout(0)` fires after StrictMode's replay has
    // already finished, so the first mount's cleanup below cancels its
    // timer before `start()` is ever called at all — only the surviving
    // mount's `start()` runs, and only one signed request goes out.
    const startTimer = setTimeout(() => void start(), 0);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      clientRef.current?.disconnect();
      clientRef.current = null;
      if (acquiredSidecar) releaseTailnetSidecar(profile.id);
    };
  }, [
    profile.id,
    profile.host,
    profile.relayPort,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
    sessionId,
  ]);

  // Foreground/background reconnection: `visibilitychange`
  // is the reliable signal on iOS (confirmed that Tauri's onFocusChanged
  // never fires there) — works the same on desktop, no platform
  // gate needed. `forceReconnect` already decides on its own whether the current
  // connection actually needs to be recreated.
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible") clientRef.current?.forceReconnect();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const sendMessage = useCallback((text: string) => {
    clientRef.current?.sendMessage(text);
  }, []);

  const stopTurn = useCallback(() => {
    clientRef.current?.stopTurn();
  }, []);

  const setCwd = useCallback((path: string) => {
    clientRef.current?.setCwd(path);
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    clientRef.current?.setPermissionMode(mode);
  }, []);

  const setModel = useCallback((newModel: ModelChoice) => {
    clientRef.current?.setModel(newModel);
  }, []);

  const clearConversation = useCallback(() => {
    clientRef.current?.clearConversation();
  }, []);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
  }, []);

  const loadOlderHistory = useCallback((beforeCursor: number) => {
    clientRef.current?.loadOlderHistory(beforeCursor);
  }, []);

  const cancelBackgroundJob = useCallback((id: string) => {
    clientRef.current?.cancelBackgroundJob(id);
  }, []);

  const editMessage = useCallback((fromEnd: number, text: string) => {
    clientRef.current?.editMessage(fromEnd, text);
  }, []);

  const setDraft = useCallback((text: string) => {
    clientRef.current?.setDraft(text);
  }, []);

  const answerChoice = useCallback((answers: ChoiceAnswer[]) => {
    const prompt = choicePromptRef.current;
    if (!prompt) return;
    clientRef.current?.answerChoice(prompt.promptId, answers);
    // Optimistic, same spirit as `dismissSuggestion` — the relay's own
    // `choice_resolved` will confirm it shortly, but clearing right away
    // avoids a flash of the same picker between the click and that round-trip.
    setChoicePrompt(null);
  }, []);

  return {
    connected,
    connectingTailnet,
    cwd,
    cwdLocked,
    permissionMode,
    model,
    defaultModel,
    contextUsage,
    protocolMismatch,
    compactBoundary,
    suggestion,
    dismissSuggestion,
    sendMessage,
    stopTurn,
    setCwd,
    setPermissionMode,
    setModel,
    clearConversation,
    loadOlderHistory,
    backgroundJobs,
    cancelBackgroundJob,
    editMessage,
    draft,
    setDraft,
    choicePrompt,
    answerChoice,
  };
}
