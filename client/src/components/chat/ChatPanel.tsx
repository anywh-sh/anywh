import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { guessMimeFromExtension } from "@/lib/mimeTypes";
import { useRelayClient } from "@/hooks/useRelayClient";
import { getDefaultPath } from "@/hooks/useDefaultPaths";
import { getPreferredModel, setLastModel } from "@/hooks/useModelPreference";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useMessageLog, type LogEntry } from "@/hooks/useMessageLog";
import { countToolCallsInCurrentTurn } from "@/lib/turnActivity";
import { useImageUpload, type PendingAttachment } from "@/hooks/useImageUpload";
import { MessageLog } from "@/components/chat/MessageLog";
import { MessageLogSkeleton } from "@/components/chat/MessageLogSkeleton";
import { ChatIdleState } from "@/components/chat/ChatIdleState";
import { TurnIndicator } from "@/components/chat/TurnIndicator";
import { Composer, type ComposerHandle } from "@/components/chat/Composer";
import { ChoiceCard } from "@/components/chat/ChoiceCard";
import { WorkingDirectoryButton } from "@/components/chat/WorkingDirectoryButton";
import { useTitleBarSlot } from "@/hooks/useTitleBarSlot";
import { FilesToggleButton } from "@/components/chat/FilesToggleButton";
import { TerminalToggleButton } from "@/components/chat/TerminalToggleButton";
import { BackgroundJobIndicator } from "@/components/chat/BackgroundJobIndicator";
import type { BackgroundJobSummary } from "@/lib/relayClient";
import { isIOS } from "@/lib/platform";
import { physicalPositionToClientPoint } from "@/lib/dragDropPosition";
import { cn } from "@/lib/utils";
import { parseSlashCommand } from "@/lib/slashCommands";
import type { Profile } from "@/lib/profiles";
import { useDict } from "@/i18n";

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
  onBackgroundJobsChange?: (jobs: BackgroundJobSummary[]) => void;
  /** Session deleted, by this device or another one — see
   * sharedSession.ts::closeAllClients. */
  onDeleted?: () => void;
  /** This session's connection state — `App` uses this to feed iOS's
   * consolidated top bar, which lives outside ChatPanel. */
  onConnectedChange?: (connected: boolean) => void;
  /** Embedded terminal — desktop only, `App` passes `undefined` on
   * iOS/compact viewport and the button doesn't even appear (see
   * renderPanel). */
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
   * passes `undefined` on compact/iOS, same gate as `terminal`/`files`
   * above (there's no file panel to open it in there). */
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
  onTitle,
  onActivity,
  onDeleted,
  onConnectedChange,
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
  const toolCallsThisTurn = useMemo(() => countToolCallsInCurrentTurn(log.entries), [log.entries]);
  const logRef = useRef(log);
  logRef.current = log;
  // Same pattern as `logRef`: the drop handler and the copy callback are
  // deliberately built once (empty dep arrays), so they can't close over a
  // dictionary that changes when the language does.
  const dictRef = useRef(dict);
  dictRef.current = dict;
  const titleBarSlot = useTitleBarSlot();
  const isActiveTabRef = useRef(isActiveTab);
  isActiveTabRef.current = isActiveTab;
  const onTurnActiveChangeRef = useRef(onTurnActiveChange);
  onTurnActiveChangeRef.current = onTurnActiveChange;
  const onBackgroundJobsChangeRef = useRef(onBackgroundJobsChange);
  onBackgroundJobsChangeRef.current = onBackgroundJobsChange;
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
  const composerRef = useRef<ComposerHandle>(null);

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
    permissionMode,
    model,
    defaultModel,
    contextUsage,
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
    dismissChoicePrompt,
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
    onTurnComplete: (stopped) => {
      logRef.current.handleTurnComplete(stopped);
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
  const appliedModelPreferenceRef = useRef(false);
  useEffect(() => {
    if (!isNewConversation || appliedModelPreferenceRef.current || !ready) return;
    appliedModelPreferenceRef.current = true;
    const preferredModel = getPreferredModel(profile.id);
    if (preferredModel && preferredModel !== model) setModel(preferredModel);
  }, [isNewConversation, ready, model, profile.id, setModel]);

  // Records the model in use as the profile's "last used" whenever
  // it changes to a concrete value — covers manual switching (`ModelButton`,
  // `/model`) and the pre-selection above itself, on purpose: turning
  // "lastUsed" mode back on later shouldn't lose what ran while "fixed" was
  // active.
  useEffect(() => {
    if (model) setLastModel(profile.id, model);
  }, [model, profile.id]);

  // Same pattern as `onTurnActiveChange` above: reports to the Tab via ref —
  // background tabs stay mounted, so this also covers a job
  // finishing outside the currently visible tab/profile.
  useEffect(() => {
    onBackgroundJobsChangeRef.current?.(backgroundJobs);
  }, [backgroundJobs]);

  const onConnectedChangeRef = useRef(onConnectedChange);
  onConnectedChangeRef.current = onConnectedChange;
  useEffect(() => {
    onConnectedChangeRef.current?.(connected);
  }, [connected]);

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

  const keyboardInfo = useKeyboardInset();

  return (
    <div ref={containerRef} className="relative flex h-full flex-col">
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
          entries={log.entries}
          streamingEntries={log.streamingEntries}
          hasMoreHistory={log.hasMoreHistory}
          loadingOlderHistory={log.loadingOlderHistory}
          onLoadOlderHistory={handleLoadOlderHistory}
          className={isIOS() ? "pt-[calc(env(safe-area-inset-top)+64px)] pb-32" : undefined}
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
        />
      ) : (
        <MessageLogSkeleton />
      )}

      {/* iOS: cwd + composer float above the log, out of normal
       * flow — the log keeps scrolling, visible (blurred) beneath the
       * composer's glass, instead of stopping above a fixed block. `bottom`
       * shifts by `keyboardInfo.shift` (`useKeyboardInset.ts`) instead of
       * staying fixed at `bottom-0` — without this an unwanted gap remains
       * between the composer and the keyboard (a real finding:
       * reproduced again on the physical device even with the fix validated
       * in the Simulator). The `safe-area-inset-bottom` padding is for the
       * home indicator area, which stops existing (replaced by the keyboard)
       * as soon as it opens, so it switches to a fixed `12px` in that state —
       * decided by `keyboardInfo.isOpen`, not by `shift > 0`: the two can
       * diverge if the layout shrinks along with the keyboard (not confirmed
       * whether this happens on the physical device), in which case `shift`
       * correctly goes to zero but the keyboard stays open. */}
      <div
        className={cn(
          isIOS()
            ? cn(
                "absolute inset-x-0 z-20 flex flex-col gap-2 px-3.5 pt-2",
                keyboardInfo.isOpen ? "pb-3" : "pb-[calc(env(safe-area-inset-bottom)+12px)]",
              )
            : "contents",
        )}
        style={isIOS() ? { bottom: keyboardInfo.shift } : undefined}
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

        {/* iOS: editing doesn't turn into an inline `<textarea>`
         * in the bubble (see `editingMessageId` above) — fills the normal
         * composer with the original text and shows this warning, since
         * sending from here will discard the original response and
         * everything that came after it.
         *
         * Rounded on purpose (iOS shell, not redesigned): it sits against the
         * iOS composer's own rounded glass, so squaring this one alone would
         * put the only hard corner on that screen. */}
        {isIOS() && editTarget && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-bg-elevated/80 px-3 py-2 text-xs text-muted-foreground backdrop-blur-lg">
            <span>{dict.chat.message.editWarning}</span>
            <button
              type="button"
              onClick={onCancelEdit}
              aria-label={dict.chat.message.cancelEdit}
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* On iOS the turn indicator lives in here (not in normal document
         * flow, like on desktop) — this whole block is `absolute bottom-0`
         * (see comment above), so an element outside it would leak out of
         * the floating area and end up rendering below the composer (near
         * the keyboard) instead of above it. */}
        {isIOS() && turnStartedAt !== null && <TurnIndicator startedAt={turnStartedAt} toolCount={toolCallsThisTurn} />}

        {/* Caps the composer column at the same width as MessageLog's content
         * — `contents` on iOS keeps these two wrapper divs out of
         * the box tree entirely, so the phone layout (which never hits the
         * cap anyway) is untouched. */}
        <div className={cn(isIOS() ? "contents" : "w-full px-4")}>
          <div className={cn(isIOS() ? "contents" : "mx-auto flex w-full max-w-3xl flex-col")}>
            {/* Always mounted on desktop — see `TurnIndicator`'s
             * own doc comment for why this can't be conditional on
             * `turnStartedAt !== null` like the iOS one below. */}
            {!isIOS() && <TurnIndicator startedAt={turnStartedAt} toolCount={toolCallsThisTurn} />}

            {choicePrompt && (
              <ChoiceCard
                promptId={choicePrompt.promptId}
                questions={choicePrompt.questions}
                kind={choicePrompt.kind}
                onAnswer={answerChoice}
                onClose={dismissChoicePrompt}
              />
            )}

            <Composer
              ref={composerRef}
              disabled={!connected}
              turnInFlight={turnInFlight}
              onStop={stopTurn}
              pendingImages={images.pending}
              uploadingImage={images.uploading}
              onAddFiles={(files) => void images.addFiles(files)}
              onRemoveImage={images.remove}
              permissionMode={permissionMode}
              onChangePermissionMode={setPermissionMode}
              model={model}
              defaultModel={defaultModel}
              onChangeModel={setModel}
              modelLocked={cwdLocked}
              contextUsage={contextUsage}
              compactBoundary={compactBoundary}
              suggestion={isIOS() ? null : suggestion}
              onChangeDraft={setDraft}
              onSend={(text, sentImages) => {
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
                const command = parseSlashCommand(text);
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
              }}
            />

            {!isIOS() && (
              <div className="mb-3 flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* The working directory itself lives in the title bar now
                   * (see the portal below) — what stays here is the job
                   * indicator, which belongs next to the composer because it
                   * is about the turn being typed, not about the window. */}
                  <BackgroundJobIndicator jobs={backgroundJobs} onCancel={cancelBackgroundJob} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {files && <FilesToggleButton cwd={cwd} open={files.open} onToggle={files.onToggle} />}
                  {terminal && <TerminalToggleButton cwd={cwd} open={terminal.open} onToggle={terminal.onToggle} />}
                </div>
              </div>
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
    </div>
  );
}
