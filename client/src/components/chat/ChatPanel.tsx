import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { guessMimeFromExtension } from "@/lib/mimeTypes";
import { useRelayClient } from "@/hooks/relay/useRelayClient";
import { getDefaultPath } from "@/hooks/useDefaultPaths";
import { getPreferredModel, setLastModel } from "@/hooks/relay/useModelPreference";
import { useNativeBottomInset } from "@/hooks/platform/useNativeBottomInset";
import { useMessageLog, type LogEntry } from "@/hooks/relay/useMessageLog";
import { recentToolCallLines, runningSubagents } from "@/lib/format/backgroundActivity";
import { useImageUpload, type PendingAttachment } from "@/hooks/media/useImageUpload";
import { MessageLog, type MessageLogHandle } from "@/components/chat/MessageLog";
import { MessageLogSkeleton } from "@/components/chat/MessageLogSkeleton";
import { ChatIdleState } from "@/components/chat/ChatIdleState";
import { Composer } from "@/components/chat/Composer";
import { NativeComposer, type NativeComposerHandle } from "@/components/chat/NativeComposer";
import { ChoiceCard } from "@/components/chat/ChoiceCard";
import { WorkingDirectoryButton } from "@/components/chat/WorkingDirectoryButton";
import { useTitleBarSlot } from "@/hooks/useTitleBarSlot";
import { usePanelTogglesSlot } from "@/hooks/usePanelTogglesSlot";
import { FilesToggleButton } from "@/components/shell/FilesToggleButton";
import { TerminalToggleButton } from "@/components/shell/TerminalToggleButton";
import { BackgroundJobIndicator } from "@/components/chat/BackgroundJobIndicator";
import { LaunchedInBackground } from "@/components/chat/LaunchedInBackground";
import type { BackgroundJobSummary, FailedBackgroundJobSummary } from "@/lib/relay/relayClient";
import { isIOS } from "@/lib/platform/platform";
import { physicalPositionToClientPoint } from "@/lib/dragDropPosition";
import { cn } from "@/lib/utils";
import { parseSlashCommand } from "@/lib/composer/slashCommands";
import { activeModelLabel, catalogHasModel } from "@/lib/composer/modelCatalog";
import type { Profile } from "@/lib/profiles/profiles";
import { useDict } from "@/i18n";

/** See `ChatPanelProps.onBackgroundActionsReady`. */
export interface BackgroundJobActions {
  cancelBackgroundJob: (id: string) => void;
  dismissFailedBackgroundJob: (id: string) => void;
  stopTurn: () => void;
}

/** See `ChatPanelProps.onTurnProgressChange`. */
export interface TurnProgress {
  startedAt: number;
  latestToolCall: string | null;
  /** Subagents this turn has running — the tray lists each one. */
  subagents: TraySubagent[];
}

export interface TraySubagent {
  toolUseId: string;
  description: string | null;
  activity: string | null;
  startedAt: number | null;
}

interface ChatPanelProps {
  profile: Profile;
  sessionId: string;
  /** Tab opened via "new conversation" — shows the idle state instead of the
   * loading skeleton while the log is still empty. */
  isNewConversation?: boolean;
  /** `lastUserText`/`lastAssistantText` are this turn's last user message and
   * the assistant's final text reply — both extracted synchronously from the
   * log, no round-trip needed. `App` uses `lastAssistantText` (cleaned up and
   * truncated) as the OS notification's body, falling back to `lastUserText`
   * when the turn produced no text (e.g. tool-only response). */
  onTurnComplete?: (result: { stopped: boolean; lastUserText: string | null; lastAssistantText: string | null }) => void;
  onTurnActiveChange?: (active: boolean) => void;
  /** Title inferred from the first prompt (or from a live rename on another
   * device) arriving over this session's WS — see sharedSession.ts. */
  onTitle?: (title: string) => void;
  /** Message sent — only used to bump the session to the top of the sidebar
   * (ordering by last interaction); the relay already persists this on its
   * own (SharedSession.onActivity), this callback is just the local
   * optimistic update, no round-trip. */
  onActivity?: () => void;
  /** `anywh-bg` jobs currently observed in this session, whenever the list
   * changes — same pattern as `onTurnActiveChange`: `App`
   * uses this to feed the tab/sidebar badge, which needs to know even with
   * the tab out of focus (it stays mounted, WS alive). */
  onBackgroundJobsChange?: (jobs: BackgroundJobSummary[], failedJobs: FailedBackgroundJobSummary[]) => void;
  /** The in-flight turn's real start instant and its latest tool call, as
   * one line — `null` between turns. Same "report up via ref" pattern as
   * `onBackgroundJobsChange`: the background-activity tray lists this tab as
   * a running agent while it isn't focused, and needs both to say for how
   * long and doing what. */
  onTurnProgressChange?: (progress: TurnProgress | null) => void;
  /** Registers this session's own `cancelBackgroundJob`/
   * `dismissFailedBackgroundJob`/`stopTurn` for the global background-activity
   * tray (`StatusBar`) to call into from OUTSIDE this tab — the tray shows
   * activity from every open tab, not just the focused one, and each tab's
   * `RelayClient`/WebSocket only exists inside that tab's own `ChatPanel`.
   * Called once on mount with the (stable, `useCallback`'d) functions, and
   * again with `null` on unmount to deregister. */
  onBackgroundActionsReady?: (actions: BackgroundJobActions | null) => void;
  /** Session deleted, by this device or another one — see
   * sharedSession.ts::closeAllClients. */
  onDeleted?: () => void;
  /** This session's connection state — `App` uses this to feed iOS's
   * consolidated top bar, which lives outside ChatPanel. */
  onConnectedChange?: (connected: boolean) => void;
  /** Label of the model the session is on (`null` until known) — for chrome
   * that lives outside the panel, like the iOS native top bar. */
  onModelLabelChange?: (label: string | null) => void;
  /** This tab's group, for portaling the files/terminal toggle pair into
   * that group's strip (see `usePanelTogglesSlot`) — `null` on compact/iOS,
   * where panels aren't available and nothing is portaled regardless. */
  groupId?: string | null;
  /** Embedded terminal — desktop only, `App` passes `undefined` on
   * iOS/compact viewport and the toggle doesn't even appear. */
  terminal?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Work dir file panel — same desktop-only gating as `terminal`. */
  files?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Opens a path mentioned in assistant text in the file panel — `App`
   * passes `undefined` on compact/iOS (there's no file panel to open it in
   * there). */
  onOpenPath?: (path: string) => void;
  /** Only the active tab should react to Tauri's native drag-and-drop —
   * unlike the old HTML5 DnD (scoped by the DOM itself), the native event
   * reaches ALL mounted instances (background tabs stay mounted),
   * so each `ChatPanel` needs to know whether it's its turn to handle the
   * drop. */
  isActiveTab: boolean;
  /** Narrower than `isActiveTab`: with split groups more than one tab is
   * visible at a time, and only one of them is the one the user is working
   * in. Drives what the title bar shows, which describes a single
   * conversation. Absent on iOS, which has neither groups nor a title bar. */
  isFocusedTab?: boolean;
}

function buildWireMessage(text: string, attachments: PendingAttachment[]): string {
  // Claude only "sees" an image via `Read` — video becomes a sequence of
  // frames extracted on the relay (ffmpeg, `uploads.ts`), referenced in
  // chronological order, plus the original video's path in case it needs to
  // run ffmpeg/ffprobe on it directly via Bash for something more specific.
  const refs = attachments
    .map((attachment) => {
      if (attachment.kind !== "video") return `[imagem anexada: ${attachment.path}]`;
      if (!attachment.frames || attachment.frames.length === 0) {
        return `[vídeo anexado (sem preview de frames): ${attachment.path}]`;
      }
      const frameLines = attachment.frames
        .map((frame, index) => `[frame ${String(index + 1)}/${String(attachment.frames!.length)}: ${frame}]`)
        .join("\n");
      return `[vídeo anexado, ${String(attachment.frames.length)} frames extraídos em ordem cronológica (arquivo original: ${attachment.path})]\n${frameLines}`;
    })
    .join("\n");
  return [text, refs].filter(Boolean).join("\n\n");
}

/** Message editing — counts how many `kind: "user"` entries exist
 * between `id` and the end of `entries` (inclusive), counting from the end
 * (`1` = the last one). Always computable from what's already loaded: history
 * pagination loads back-to-front, so anything AFTER an already-rendered
 * message is also already loaded. `null` if `id` isn't found (shouldn't
 * happen — the id comes from an entry rendered right now). */
function computeFromEnd(entries: LogEntry[], id: string): number | null {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "user") continue;
    count++;
    if (entry.id === id) return count;
  }
  return null;
}

export function ChatPanel({
  profile,
  sessionId,
  isNewConversation,
  onTurnComplete,
  onTurnActiveChange,
  onBackgroundJobsChange,
  onTurnProgressChange,
  onBackgroundActionsReady,
  onTitle,
  onActivity,
  onDeleted,
  onConnectedChange,
  onModelLabelChange,
  groupId = null,
  terminal,
  files,
  onOpenPath,
  isActiveTab,
  isFocusedTab = false,
}: ChatPanelProps) {
  const dict = useDict();
  const log = useMessageLog();
  // Recomputed only when an entry is actually appended — `log.entries` keeps
  // its identity while text streams in (that lands in `streamingText`), so
  // this doesn't walk the log once per token.
  const logRef = useRef(log);
  logRef.current = log;
  // Same pattern as `logRef`: the drop handler and the copy callback are
  // deliberately built once (empty dep arrays), so they can't close over a
  // dictionary that changes when the language does.
  const dictRef = useRef(dict);
  dictRef.current = dict;
  const titleBarSlot = useTitleBarSlot();
  // Only this tab's group's own active tab may claim the slot — with split
  // groups, `isActiveTab` can be true for more than one tab at once (one per
  // group), unlike `isFocusedTab` above which is at most one in the whole
  // app.
  const panelTogglesSlot = usePanelTogglesSlot(isActiveTab ? groupId : null);
  const isActiveTabRef = useRef(isActiveTab);
  isActiveTabRef.current = isActiveTab;
  const onTurnActiveChangeRef = useRef(onTurnActiveChange);
  onTurnActiveChangeRef.current = onTurnActiveChange;
  const onBackgroundJobsChangeRef = useRef(onBackgroundJobsChange);
  onBackgroundJobsChangeRef.current = onBackgroundJobsChange;
  const onTurnProgressChangeRef = useRef(onTurnProgressChange);
  onTurnProgressChangeRef.current = onTurnProgressChange;
  const onBackgroundActionsReadyRef = useRef(onBackgroundActionsReady);
  onBackgroundActionsReadyRef.current = onBackgroundActionsReady;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  // The relay resends the whole session history on every new connection
  // (`SharedSession.addClient`), including `turn_complete` from old turns —
  // necessary to rebuild the message log when reopening a tab, but shouldn't
  // count as "turn complete" for the badge/notification. `caughtUpRef` only
  // becomes `true` after the `caught_up` marker, which the relay sends right
  // after the replay — from then on events are truly live.
  const caughtUpRef = useRef(false);
  // Same signal, but in state — triggers the re-render that swaps the
  // skeleton for the real log. Goes back to `false` on a real reconnection
  // (`onReconnecting`) — the replay will arrive again from
  // scratch, so the skeleton briefly reappears instead of showing the
  // emptied log with no indication at all.
  const [ready, setReady] = useState(false);

  const images = useImageUpload(profile, (message) => window.alert(message));
  // Either composer answers to the same handle; only the native one can close
  // the keyboard on its own (`blurIfFocused`).
  const composerRef = useRef<NativeComposerHandle>(null);
  const messageLogRef = useRef<MessageLogHandle>(null);
  // iOS: the "jump to end" arrow is native, the log tells us when to show it.
  const [scrollToEndVisible, setScrollToEndVisible] = useState(false);
  // iOS: the web stack floating above the native composer (cwd row,
  // `ChoiceCard`). Its height pads the log and lifts the native arrow above it.
  const floatingStackRef = useRef<HTMLDivElement>(null);
  const [floatingStackHeight, setFloatingStackHeight] = useState(0);
  const nativeBottomInset = useNativeBottomInset();
  useEffect(() => {
    const el = floatingStackRef.current;
    if (!isIOS() || !el) return;
    const observer = new ResizeObserver(() => setFloatingStackHeight(Math.round(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Message editing. `fromEnd` is computed once, at the moment of
  // clicking "edit" (`computeFromEnd`), and stored here instead of
  // recomputed at save time — avoids depending on the log not having changed
  // in between. `editTargetRef`/`performEditRef` exist so
  // `onStartEdit`/`onSaveEdit`/`onSend` always read the latest value without
  // entering as a dependency of any `useCallback` — that's what keeps those
  // callbacks' identity stable across renders (see the `memo` comment in
  // `Message.tsx`: without this, ALL bubbles would lose the memo bail-out on
  // every `ChatPanel` render, not just the one being edited).
  const [editTarget, setEditTarget] = useState<{ id: string; fromEnd: number } | null>(null);
  const editTargetRef = useRef(editTarget);
  editTargetRef.current = editTarget;
  const performEditRef = useRef<(id: string, text: string) => void>(() => {});

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tauri's native drag-and-drop (`onDragDropEvent`), not HTML5 DnD — the
  // previous version (DOM dragenter/dragover/drop + `dragDropEnabled:
  // false`) was never actually confirmed with a real drag on macOS (only on
  // Windows); the user reported nothing happened there, consistent
  // with known WKWebView bugs around this browser API. The native event
  // delivers the file's real path on disk — read via the Rust command
  // `read_dropped_file` (raw bytes, without going through the browser's
  // `File` API) and wrapped in a local `File` to reuse the same upload
  // pipeline as the attach button.
  //
  // The event reaches ALL mounted tabs (background tabs stay mounted),
  // not just the visible one — hence the `isActiveTabRef` guard.
  // It also reaches every panel sharing the window (the file panel has its
  // own native drop target since it added drag-and-drop upload) — `position`
  // (physical pixels) is checked against this component's own bounding
  // element via `elementFromPoint` so a drop over the file panel is left
  // entirely to its own handler instead of also being attached here.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!isActiveTabRef.current) return;

        if (event.payload.type === "leave") {
          setIsDraggingOver(false);
          return;
        }

        const { x, y } = physicalPositionToClientPoint(event.payload.position);
        const target = document.elementFromPoint(x, y);
        const withinChat = containerRef.current?.contains(target) ?? false;

        if (event.payload.type === "drop") {
          setIsDraggingOver(false);
          if (!withinChat) return;
          const paths = event.payload.paths;
          void (async () => {
            const files: File[] = [];
            for (const path of paths) {
              try {
                const buffer = await invoke<ArrayBuffer>("read_dropped_file", { path });
                const name = path.split(/[\\/]/).pop() ?? dictRef.current.chat.composer.droppedFile;
                files.push(new File([buffer], name, { type: guessMimeFromExtension(name) }));
              } catch (error) {
                console.error("[anywh] failed to read dropped file:", path, error);
              }
            }
            if (files.length > 0) {
              await images.addFiles(files);
              composerRef.current?.focus();
            }
          })();
        } else {
          setIsDraggingOver(withinChat);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Covers from clicking "Send" until the turn ends (success or error) — not
  // just the model's response time, also the network round trip, to never
  // give a stuck feeling (user feedback). Stores the start instant (not just
  // a boolean) so `TurnIndicator` can time from the turn's real start, not
  // from when this component found out — important for the device that
  // DIDN'T send the message (see `onTurnState` below, a finding from testing
  // multi-device: without this only the sender saw the "thinking"
  // indicator). Optimistic here (`Date.now()` on the send click, before the
  // round trip with the relay), corrected by the real `startedAt` as soon as
  // `onTurnState` arrives.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnInFlight = turnStartedAt !== null;

  // Reports the state to the Tab (`isRunning`) via ref — background tabs
  // stay mounted, so this also covers turns running outside the
  // currently visible tab/profile.
  useEffect(() => {
    onTurnActiveChangeRef.current?.(turnInFlight);
  }, [turnInFlight]);

  // Profile's default folder (Settings) trying to apply itself on a new
  // conversation — see the effect right below `useRelayClient`. If the relay
  // refuses (deleted folder, no permission), the error shouldn't turn into
  // an alert with no user action behind it: this flag makes `onSetCwdError`
  // swallow only THIS failure, keeping the normal alert for a manual switch
  // via `WorkingDirectoryButton`.
  const suppressNextCwdErrorRef = useRef(false);

  const {
    connected,
    cwd,
    cwdLocked,
    agentId,
    permissionMode,
    permissionModes,
    model,
    modelCatalog,
    contextUsage,
    protocolMismatch,
    compactBoundary,
    suggestion,
    dismissSuggestion,
    sendMessage,
    stopTurn,
    setCwd,
    setAgent,
    setPermissionMode,
    setModel,
    clearConversation,
    requestContextBreakdown,
    loadOlderHistory,
    backgroundJobs,
    cancelBackgroundJob,
    failedBackgroundJobs,
    dismissFailedBackgroundJob,
    editMessage,
    draft,
    setDraft,
    choicePrompt,
    answerChoice,
  } = useRelayClient(profile, sessionId, {
    onEvent: (event) => logRef.current.handleEvent(event),
    onReconnecting: () => {
      logRef.current.reset();
      caughtUpRef.current = false;
      setReady(false);
    },
    // `/clear` — same log clearing a real reconnection already
    // does, just without going through `ready`/skeleton (the conversation
    // stays "ready", it just became empty).
    onConversationReset: () => logRef.current.reset(),
    // Initial history tail — arrives before
    // `onCaughtUp`, hydrates the log with a single dispatch instead of the
    // old event-by-event replay.
    onHistoryPage: (page) => logRef.current.hydrate(page),
    // Older turns requested via scrolling up.
    onOlderHistory: (page) => logRef.current.prependHistory(page),
    // Message edited on ANOTHER device connected to this session —
    // same reset+hydrate handling as `onReconnecting`/`onHistoryPage`, just
    // without touching `ready`/`caughtUpRef`: this device is already caught
    // up, it's not a real reconnection.
    onHistoryTruncated: (page) => {
      logRef.current.reset();
      logRef.current.hydrate(page);
    },
    onEditMessageError: (code) => window.alert(dict.errors.editMessage[code]),
    onCaughtUp: () => {
      caughtUpRef.current = true;
      setReady(true);
    },
    onTurnComplete: (stopped, durationMs) => {
      logRef.current.handleTurnComplete(stopped, durationMs);
      setTurnStartedAt(null);
      if (!caughtUpRef.current) return;
      const entries = [...logRef.current.entries].reverse();
      const lastUserEntry = entries.find((entry) => entry.kind === "user");
      const lastTextEntry = entries.find((entry) => entry.kind === "text");
      onTurnComplete?.({
        stopped,
        lastUserText: lastUserEntry?.kind === "user" ? lastUserEntry.text : null,
        lastAssistantText: lastTextEntry?.kind === "text" ? lastTextEntry.text : null,
      });
    },
    onTurnError: (message) => {
      logRef.current.handleTurnError(message);
      setTurnStartedAt(null);
    },
    // A turn in progress is SESSION state, not sender state — without this,
    // a device that didn't start the turn (or that connects mid-turn) would
    // never see the "thinking" indicator/timer (a real finding from testing
    // multi-device). The relay's `startedAt` corrects the timer to the real
    // start; the send's optimistic `setTurnStartedAt(Date.now())`
    // (Composer.onSend) already covers the instant between the click and
    // this event coming back.
    onTurnState: (state) => setTurnStartedAt(state.active ? (state.startedAt ?? Date.now()) : null),
    onSetCwdError: (code) => {
      if (suppressNextCwdErrorRef.current) {
        suppressNextCwdErrorRef.current = false;
        return;
      }
      window.alert(`${dict.errors.setCwdTitle}: ${dict.errors.setCwd[code]}`);
    },
    onSessionTitle: (title) => onTitleRef.current?.(title),
    onSessionDeleted: () => onDeletedRef.current?.(),
  });

  // Applies the profile's default path (Settings) as soon as the new
  // conversation receives its first `cwd_state` — the relay always delivers
  // its own default at this moment (a session never starts locked, see
  // comment in `WorkingDirectoryButton`), so this is the same as the user
  // picking the folder right away, just automatic. Runs at most once per tab
  // (`appliedDefaultPathRef`): after that the user can switch freely without
  // the effect insisting on going back to the default on every re-render.
  const appliedDefaultPathRef = useRef(false);
  useEffect(() => {
    if (!isNewConversation || appliedDefaultPathRef.current || cwd === null) return;
    appliedDefaultPathRef.current = true;
    const defaultPath = getDefaultPath(profile.id);
    if (defaultPath && defaultPath !== cwd) {
      suppressNextCwdErrorRef.current = true;
      setCwd(defaultPath);
    }
  }, [isNewConversation, cwd, profile.id, setCwd]);

  // Prompt-draft feature: restore whatever was saved for this tab, but only
  // once — `draft` keeps arriving on every `draft_state` broadcast (e.g. an
  // echo of our own debounced save, or a change from another device on the
  // same session), and reapplying those into the composer would clobber text
  // the user is actively typing here. Same "apply once" idiom as
  // `appliedDefaultPathRef` above; never resets because `ChatPanel` is
  // mounted once per tab for its whole lifetime (`key={tab.id}` in App.tsx,
  // TabGroupLayout's flat panel layer).
  const appliedDraftRef = useRef(false);
  useEffect(() => {
    if (draft === null || appliedDraftRef.current) return;
    appliedDraftRef.current = true;
    if (draft) composerRef.current?.setContent(draft);
  }, [draft]);

  // Applies the profile's model preference (Settings) on a new conversation
  // — same reasoning as the default-folder effect above, but triggered on
  // `ready` (post `caught_up`) instead of `cwd !== null`: the relay's
  // initial `model_state` can genuinely arrive as `null` (session never had
  // `/model`), which would make it indistinguishable from "hasn't arrived
  // yet" — `ready` already guarantees that first `model_state` (always sent
  // before `caught_up`, see `SharedSession.addClient`) has been processed.
  //
  // Also waits on the session's agent's catalog, and only applies a
  // preference that catalog actually lists: a preference is a model id of
  // ONE agent ("opus" means nothing to Codex), so it can't be applied
  // blindly to whichever agent this session runs.
  const appliedModelPreferenceRef = useRef(false);
  useEffect(() => {
    if (!isNewConversation || appliedModelPreferenceRef.current || !ready || !agentId || !modelCatalog) return;
    appliedModelPreferenceRef.current = true;
    const preferredModel = getPreferredModel(profile.id, agentId);
    if (preferredModel && preferredModel !== model && catalogHasModel(modelCatalog, preferredModel)) setModel(preferredModel);
  }, [isNewConversation, ready, agentId, modelCatalog, model, profile.id, setModel]);

  // Records the model in use as the profile's "last used" whenever
  // it changes to a concrete value — covers manual switching (`ModelButton`,
  // `/model`) and the pre-selection above itself, on purpose: turning
  // "lastUsed" mode back on later shouldn't lose what ran while "fixed" was
  // active.
  useEffect(() => {
    if (model && agentId) setLastModel(profile.id, agentId, model);
  }, [model, agentId, profile.id]);

  // Same pattern as `onTurnActiveChange` above: reports to the Tab via ref —
  // background tabs stay mounted, so this also covers a job
  // finishing outside the currently visible tab/profile.
  useEffect(() => {
    onBackgroundJobsChangeRef.current?.(backgroundJobs, failedBackgroundJobs);
  }, [backgroundJobs, failedBackgroundJobs]);

  // Only the latest call, and only as a string: the effect below then fires
  // once per tool call rather than once per log append, so a busy turn in a
  // background tab doesn't re-render `App` more than the tray needs.
  const latestToolCall = useMemo(
    () => (turnStartedAt === null ? null : (recentToolCallLines(log.entries, cwd, { limit: 1 })[0] ?? null)),
    [turnStartedAt, log.entries, cwd],
  );
  const subagents = useMemo(() => runningSubagents(log.entries, log.subagents, cwd), [log.entries, log.subagents, cwd]);

  // Keyed on the serialized list so the effect below only reports a change
  // the tray can actually show — not every `log.entries` identity change.
  const traySubagentsKey = JSON.stringify(
    subagents.map(({ toolUseId, description, activity, startedAt }): TraySubagent => ({ toolUseId, description, activity, startedAt })),
  );

  useEffect(() => {
    onTurnProgressChangeRef.current?.(
      turnStartedAt === null
        ? null
        : { startedAt: turnStartedAt, latestToolCall, subagents: JSON.parse(traySubagentsKey) as TraySubagent[] },
    );
  }, [turnStartedAt, latestToolCall, traySubagentsKey]);

  // Desktop: the background work this conversation launched sits right after
  // the latest message, inside the scrolling log — not pinned above the
  // composer — so it reads as the tail of the conversation and scrolls with
  // it. Memoized because `MessageLog` is `memo`'d and this would otherwise be
  // a new element on every `ChatPanel` render.
  const hasLaunchedInBackground = backgroundJobs.length > 0 || subagents.length > 0;
  const logTrailing = useMemo(
    () =>
      isIOS() || !hasLaunchedInBackground ? null : (
        <div className="flex flex-col gap-2 pt-1 pb-2.5">
          <LaunchedInBackground
            profile={profile}
            sessionId={sessionId}
            live={isActiveTab}
            jobs={backgroundJobs}
            onCancelJob={cancelBackgroundJob}
            agents={subagents}
            onStopAgent={stopTurn}
          />
        </div>
      ),
    // `profile` is a fresh object on most renders; its id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      hasLaunchedInBackground,
      profile.id,
      sessionId,
      isActiveTab,
      backgroundJobs,
      cancelBackgroundJob,
      subagents,
      stopTurn,
    ],
  );

  // Registers this tab's own background-job actions once (all three are
  // `useCallback`'d with no deps in `useRelayClient`, so their identity is
  // stable across reconnects — no need to re-register on every change) and
  // deregisters on unmount, so the global tray never holds a stale entry for
  // a closed tab.
  useEffect(() => {
    onBackgroundActionsReadyRef.current?.({ cancelBackgroundJob, dismissFailedBackgroundJob, stopTurn });
    return () => onBackgroundActionsReadyRef.current?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnectedChangeRef = useRef(onConnectedChange);
  onConnectedChangeRef.current = onConnectedChange;
  useEffect(() => {
    onConnectedChangeRef.current?.(connected);
  }, [connected]);

  const onModelLabelChangeRef = useRef(onModelLabelChange);
  onModelLabelChangeRef.current = onModelLabelChange;
  const modelLabel = activeModelLabel(modelCatalog, model);
  useEffect(() => {
    onModelLabelChangeRef.current?.(modelLabel);
  }, [modelLabel]);

  // Message editing: truncates locally (optimistic, like a normal
  // send) and sends `edit_message` — the relay stops the current turn (if
  // any), cuts the real transcript at the right point and runs a new turn.
  // If `target.id` no longer matches the requested `id` (e.g. another edit
  // already ran in between), ignores instead of truncating in the wrong
  // spot.
  performEditRef.current = (id, newText) => {
    const target = editTargetRef.current;
    if (!target || target.id !== id) return;
    log.editUserMessage(id, newText);
    editMessage(target.fromEnd, newText);
    setTurnStartedAt(Date.now());
    setEditTarget(null);
    dismissSuggestion();
    onActivity?.();
  };

  // Stable identity (refs inside, not depending on state/props in the deps
  // array) — see the comment at the top of the component about why this
  // matters for `UserBubble`/`MessageLog`'s `memo`.
  const onStartEdit = useCallback((id: string, text: string) => {
    const fromEnd = computeFromEnd(logRef.current.entries, id);
    if (fromEnd === null) return;
    setEditTarget({ id, fromEnd });
    // On iOS editing happens via the composer (the bubble doesn't
    // turn into an input there) — fills it with the original text and shows
    // the warning (see JSX below). On desktop this does nothing:
    // `editingMessageId` is already enough for `UserBubble` to turn into a
    // `<textarea>` on its own.
    if (isIOS()) {
      composerRef.current?.setContent(text);
      composerRef.current?.focus();
    }
  }, []);

  const onCancelEdit = useCallback(() => {
    setEditTarget(null);
    if (isIOS()) composerRef.current?.setContent("");
  }, []);

  const onSaveEdit = useCallback((id: string, text: string) => {
    performEditRef.current(id, text);
  }, []);

  const onCopyMessage = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      window.alert(dictRef.current.chat.message.copyFailed);
    });
  }, []);

  // Fired by `MessageLog` when scrolling near the top —
  // the guard lives here (not just in `MessageLog`) because `logRef` is the
  // most up-to-date source of truth for pagination state, without depending
  // on a re-render.
  const handleLoadOlderHistory = useCallback(() => {
    const current = logRef.current;
    if (current.loadingOlderHistory || !current.hasMoreHistory || current.historyCursor === null) return;
    current.beginLoadingOlderHistory();
    loadOlderHistory(current.historyCursor);
  }, [loadOlderHistory]);

  // Focuses the composer as soon as a new conversation's tab mounts — lets
  // you type right away without clicking the field (e.g. Ctrl/Cmd+N and
  // start typing immediately).
  useEffect(() => {
    if (isNewConversation) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The message log itself is on screen (not the idle state or the skeleton).
  const showingLog = ready && !((isNewConversation || ready) && log.entries.length === 0 && log.streamingEntries.length === 0);
  useEffect(() => {
    if (!showingLog) setScrollToEndVisible(false);
  }, [showingLog]);
  const logBottomPadding = nativeBottomInset + 16 + floatingStackHeight;

  const handleSend = (text: string, sentImages: PendingAttachment[]): void => {
    // Editing via composer (iOS) — the normal send (slash
    // commands, `addUserMessage`+`sendMessage`) doesn't apply here:
    // the text goes to `edit_message`, not `user_message`. Images
    // attached in this state are ignored on purpose (editing a
    // message with an image is out of scope for v1).
    if (editTargetRef.current) {
      performEditRef.current(editTargetRef.current.id, text);
      return;
    }
    // `/model`/`/clear`: recognized here, before becoming
    // a turn — neither one gets passed as text to `claude -p` (see
    // slashCommands.ts for the reason behind each). A command with
    // an uncurated argument (`/model gpt4`) falls into the `else`,
    // becomes a normal message and the CLI itself responds with its
    // own error. Still recognized on iOS even without the
    // autocomplete menu (see Composer.tsx) — there's no toolbar
    // button there to change model/permission mode, so typing the
    // command is the only way to do it on that platform.
    const command = parseSlashCommand(text, modelCatalog);
    if (command?.name === "clear") {
      clearConversation();
      return;
    }
    if (command?.name === "model") {
      setModel(command.model);
      return;
    }
    log.addUserMessage(text, sentImages);
    sendMessage(buildWireMessage(text, sentImages));
    images.clearWithoutRevoke();
    setTurnStartedAt(Date.now());
    dismissSuggestion();
    onActivity?.();
  };

  return (
    <div ref={containerRef} className="relative flex h-full flex-col">
      {protocolMismatch !== null && (
        // Full takeover, not a dismissible toast: past this point nothing
        // the relay sends is guaranteed to render correctly (see
        // relayClient.ts's handling of `protocol_version`), so there's no
        // partial-functionality state to fall back to underneath it.
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-background/95 p-6 text-center">
          <p className="text-sm font-medium">{dict.chat.protocolMismatch.title}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{dict.chat.protocolMismatch.message}</p>
        </div>
      )}

      {isDraggingOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/90 text-sm text-primary">
          <ImagePlus className="size-4" />
          {dict.chat.composer.dropzone}
        </div>
      )}

      {(isNewConversation || ready) && log.entries.length === 0 && log.streamingEntries.length === 0 ? (
        // `isNewConversation` covers the freshly opened tab (shows idle right
        // away, without waiting for `ready` — there's really nothing to load
        // anyway). `ready` covers an existing session that genuinely became
        // empty — after a `/clear`, for example — without this
        // second condition the screen would just be blank (neither idle nor
        // skeleton) until the next turn, because `isNewConversation` had
        // already been `false` for a long time.
        <ChatIdleState />
      ) : ready ? (
        <MessageLog
          ref={messageLogRef}
          entries={log.entries}
          streamingEntries={log.streamingEntries}
          attributionByToolUseId={log.attributionByToolUseId}
          hasMoreHistory={log.hasMoreHistory}
          loadingOlderHistory={log.loadingOlderHistory}
          onLoadOlderHistory={handleLoadOlderHistory}
          className={isIOS() ? "pt-[var(--native-top-inset,calc(env(safe-area-inset-top)+64px))]" : undefined}
          // The native composer floats over the log: pad by its measured
          // strip, a little air, and the web stack above it.
          style={isIOS() ? { paddingBottom: logBottomPadding } : undefined}
          endInsetKey={isIOS() ? logBottomPadding : undefined}
          onScrollToEndVisibleChange={isIOS() ? setScrollToEndVisible : undefined}
          // Scrolling the log closes the keyboard, as tapping out of the web editor used to.
          onUserScrollStart={isIOS() ? () => composerRef.current?.blurIfFocused?.() : undefined}
          // On iOS editing never turns into an inline `<textarea>`
          // — `ChatPanel` never passes an id along on that platform, even
          // with `editTarget` set (see warning in the composer below).
          editingMessageId={isIOS() ? null : (editTarget?.id ?? null)}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onSaveEdit={onSaveEdit}
          onCopy={onCopyMessage}
          onOpenPath={onOpenPath}
          cwd={cwd}
          isActiveTab={isActiveTab}
          trailing={logTrailing}
        />
      ) : (
        <MessageLogSkeleton />
      )}

      {/* iOS: the composer is native (and so is the strip under it). What stays
       * web — the cwd row and `ChoiceCard` — floats above that strip, out of
       * normal flow, so the log keeps scrolling visibly beneath it. `bottom`
       * follows the inset the native side publishes (`--native-bottom-inset`),
       * keyboard included; the CSS variable jumps to its final value while the
       * keyboard animates natively, so a short transition covers the gap. */}
      <div
        ref={floatingStackRef}
        className={cn(isIOS() ? "absolute inset-x-0 z-20 flex flex-col gap-2 px-3.5 pb-2" : "contents")}
        style={isIOS() ? { bottom: "var(--native-bottom-inset, 96px)", transition: "bottom 250ms ease-out" } : undefined}
      >
        {/* iOS keeps this row above the composer (unchanged) — on desktop it
         * moved below (see after `Composer`) to make room for `ChoiceCard`
         * sitting right above the input, like Claude Desktop's own
         * `AskUserQuestion` card. */}
        {isIOS() && (
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-1.5">
              <WorkingDirectoryButton
                profile={profile}
                cwd={cwd}
                locked={cwdLocked}
                connected={connected}
                isNewConversation={isNewConversation}
                onSetCwd={setCwd}
                onFocusComposer={() => composerRef.current?.focus()}
              />
              <BackgroundJobIndicator jobs={backgroundJobs} onCancel={cancelBackgroundJob} />
            </div>
          </div>
        )}

        {/* Caps the composer column at the same width as MessageLog's content
         * — `contents` on iOS keeps these two wrapper divs out of
         * the box tree entirely, so the phone layout (which never hits the
         * cap anyway) is untouched. */}
        <div className={cn(isIOS() ? "contents" : "w-full px-4")}>
          <div className={cn(isIOS() ? "contents" : "mx-auto flex w-full max-w-3xl flex-col")}>
            {choicePrompt && (
              <ChoiceCard
                promptId={choicePrompt.promptId}
                questions={choicePrompt.questions}
                kind={choicePrompt.kind}
                onAnswer={answerChoice}
              />
            )}

            {isIOS() ? (
              <NativeComposer
                ref={composerRef}
                disabled={!connected}
                turnInFlight={turnInFlight}
                turnStartedAt={turnStartedAt}
                onStop={stopTurn}
                pendingImages={images.pending}
                uploadingImage={images.uploading}
                onAddFiles={(files) => void images.addFiles(files)}
                onRemoveImage={images.remove}
                modelCatalog={modelCatalog}
                onChangeDraft={setDraft}
                onSend={handleSend}
                editBannerText={editTarget ? dict.chat.message.editWarning : null}
                onCancelEdit={onCancelEdit}
                onScrollToEnd={() => messageLogRef.current?.scrollToEnd()}
                scrollToEndVisible={scrollToEndVisible && showingLog}
                accessoryHeight={floatingStackHeight}
              />
            ) : (
              <Composer
                ref={composerRef}
                profile={profile}
                disabled={!connected}
                turnInFlight={turnInFlight}
                turnStartedAt={turnStartedAt}
                onStop={stopTurn}
                pendingImages={images.pending}
                uploadingImage={images.uploading}
                onAddFiles={(files) => void images.addFiles(files)}
                onRemoveImage={images.remove}
                agentId={agentId}
                onChangeAgent={setAgent}
                permissionMode={permissionMode}
                permissionModes={permissionModes}
                onChangePermissionMode={setPermissionMode}
                model={model}
                modelCatalog={modelCatalog}
                onChangeModel={setModel}
                modelLocked={cwdLocked}
                contextUsage={contextUsage}
                onRequestContextBreakdown={requestContextBreakdown}
                compactBoundary={compactBoundary}
                suggestion={suggestion}
                onChangeDraft={setDraft}
                onSend={handleSend}
              />
            )}
          </div>
        </div>
      </div>

      {/* Only the focused tab paints the title bar's center, and only on
       * desktop (iOS has no title bar and keeps its own copy of this button
       * above the composer). Rendering from here rather than lifting `cwd`
       * into `App` keeps a value every mounted tab reports on connect out of
       * the state that re-renders every mounted tab — see titleBarSlot.ts. */}
      {!isIOS() && isFocusedTab && titleBarSlot
        ? createPortal(
            <WorkingDirectoryButton
              profile={profile}
              cwd={cwd}
              locked={cwdLocked}
              connected={connected}
              isNewConversation={isNewConversation}
              onSetCwd={setCwd}
              onFocusComposer={() => composerRef.current?.focus()}
            />,
            titleBarSlot,
          )
        : null}

      {/* This group's own active tab claims the strip's toggle slot — see
       * panelTogglesSlot.ts for why this is a portal rather than `cwd`
       * (only known here, on this tab's own socket) flowing down as a prop.
       * Disabled until the session has a folder: the terminal is born in it
       * (terminalSession.ts) and there's nothing for the file tree to list
       * without one — same gate the keyboard shortcuts don't have (they
       * already no-op on a group with no active tab, which subsumes this). */}
      {panelTogglesSlot && files && terminal
        ? createPortal(
            <>
              <FilesToggleButton disabled={!cwd} open={files.open} onToggle={files.onToggle} />
              <TerminalToggleButton disabled={!cwd} open={terminal.open} onToggle={terminal.onToggle} />
            </>,
            panelTogglesSlot,
          )
        : null}
    </div>
  );
}
