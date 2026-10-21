import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageControl } from "@/components/shell/LanguageControl";
import { useAppUpdate, useDownloadedUpdate } from "@/hooks/platform/useAppUpdate";
import { backgroundActivityProfileColor, type BackgroundActivityItem } from "@/hooks/useBackgroundActivity";
import { useBackgroundJobLog } from "@/hooks/useBackgroundJobLog";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { logTailLines } from "@/lib/format/backgroundActivity";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { getGitStatus } from "@/lib/relay/gitClient";
import { formatDurationLong, cn } from "@/lib/utils";
import { findProfile, type Profile } from "@/lib/profiles/profiles";
import { totalRoomStatuses, useRoomStatuses } from "@/lib/sala/roomStatus";

interface StatusBarProps {
  /** The focused tab's profile — `null` with no tab open at all. */
  profile: Profile | null;
  /** The focused tab's id, which is also its session id relay-side. */
  sessionId: string | null;
  /** Whether that session is mid-turn. Not displayed: it is here because a
   * turn is the most likely thing to have changed the folder. */
  isRunning: boolean;
  windowFocused: boolean;
  /** Whether the focused tab's relay connection is up. Drawn at the right end,
   * next to the version; omitted by a caller that has no connection to report. */
  connected?: boolean;
  /** Opens `UpdateModal` — only reachable from here while an update is
   * actually available; the version slot is plain text otherwise. */
  onOpenUpdateModal: () => void;
  /** Cross-session background activity — see `useBackgroundActivity`. */
  backgroundActivity: BackgroundActivityItem[];
  /** "abrir" — jumps to the item's tab, closes the panel. */
  onOpenBackgroundActivityItem: (item: BackgroundActivityItem) => void;
  /** "parar" — cancels the `anywh-bg` job, or stops the other tab's turn. */
  onStopBackgroundActivityItem: (item: BackgroundActivityItem) => void;
  /** "descartar" — drops a failed item from the list. */
  onDismissBackgroundActivityItem: (item: BackgroundActivityItem) => void;
  /** Footer "parar tudo". */
  onStopAllBackgroundActivity: () => void;
}

/** The status bar's room figures: every room's agents folded into the same
 * "running / need you / failed" line as the background activity. */

/** What the left half renders when there is anything to render. A folder
 * outside a repository, an unreachable machine and a host without git all
 * collapse into `null` instead of a variant of their own — the segment has
 * one appearance for "nothing to say", and giving them one shared shape is
 * also what lets the state update bail out instead of committing a render
 * that would paint the same thing again (see below). */
type RepoState = { branch: string; detached: boolean; changes: number } | null;

function sameRepo(a: RepoState, b: RepoState): boolean {
  if (a === null || b === null) return a === b;
  return a.branch === b.branch && a.detached === b.detached && a.changes === b.changes;
}

function ActivityRow({
  item,
  onOpen,
  onStop,
  onDismiss,
}: {
  item: BackgroundActivityItem;
  onOpen: () => void;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const dict = useDict();
  const strings = dict.shell.statusBar.backgroundActivity;
  const elapsedSeconds = useElapsedSeconds(item.time ?? 0);
  const failed = item.status === "fail";
  // Rows only exist while the tray is open, so a running job's log is read
  // exactly while someone is looking at it — see `useBackgroundJobLog`.
  const liveLog = useBackgroundJobLog(
    findProfile(item.profileId),
    item.tabId,
    item.id,
    item.kind === "proc" && item.status === "run",
  );
  const tailLines =
    item.kind === "agent"
      ? [item.tail || strings.agentTail]
      : failed
        ? logTailLines(item.tail, 1)
        : logTailLines(liveLog.tail ?? "", 2);
  const duration = item.time === null ? null : formatDurationLong(elapsedSeconds);
  // The last line is the row's fixed slot (it also holds the actions), so it
  // never renders blank: with no output to show it says why instead.
  const placeholder =
    tailLines.length > 0
      ? null
      : failed
        ? strings.noOutput
        : liveLog.status === "loading"
          ? strings.logLoading
          : liveLog.status === "unavailable"
            ? strings.logUnavailable
            : strings.noOutput;
  const lastLine = placeholder ?? tailLines[tailLines.length - 1];
  const tailClassName = cn("font-mono text-[11px]", failed && placeholder === null ? "text-destructive" : "text-text-faint");

  return (
    <div className="group relative flex items-start gap-2.5 py-2 pr-3 pl-[18px] transition-colors hover:bg-surface-hover">
      <span
        className="absolute top-2 bottom-2 left-2 w-0.5 opacity-80"
        style={{ background: backgroundActivityProfileColor(item) }}
        aria-hidden="true"
      />
      {item.status === "run" ? (
        item.kind === "agent" ? (
          <span className="mt-0.5 size-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" />
        ) : (
          <span className="mt-1 size-2.5 shrink-0 bg-diff-add" />
        )
      ) : (
        <span className="mt-1 size-2.5 shrink-0 bg-destructive" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "shrink-0 border px-1 py-px font-mono text-[9px] font-medium tracking-wider",
              item.kind === "agent" ? "border-primary bg-primary-soft text-primary-ink" : "border-border text-text-faint",
            )}
          >
            {item.kind === "agent" ? strings.agentBadge : strings.procBadge}
          </span>
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-foreground">{item.name}</span>
          {duration !== null && (
            <span className="shrink-0 font-mono text-[11px] text-text-faint">
              {failed ? strings.timeAgo.replace("{time}", duration) : duration}
            </span>
          )}
        </div>
        {tailLines.slice(0, -1).map((line, index) => (
          <div key={index} title={line} className={cn("truncate", tailClassName)}>
            {line}
          </div>
        ))}
        {/* The last line doubles as the actions' fixed slot: every row keeps
         * the same shape, the actions never cover text, and there is no line
         * left empty just to hold buttons that only show on hover. */}
        <div className="flex items-center gap-2">
          <span title={lastLine} className={cn("min-w-0 flex-1 truncate", tailClassName, placeholder !== null && "italic opacity-70")}>
            {lastLine}
          </span>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {failed ? (
              <button
                type="button"
                onClick={onDismiss}
                className="cursor-pointer px-1.5 py-px font-sans text-[12px] text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
              >
                {strings.dismiss}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onOpen}
                  className="cursor-pointer px-1.5 py-px font-sans text-[12px] text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
                >
                  {strings.open}
                </button>
                <button
                  type="button"
                  onClick={onStop}
                  className="cursor-pointer px-1.5 py-px font-sans text-[12px] text-destructive transition-colors hover:bg-destructive/10"
                >
                  {strings.stop}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The strip along the bottom of the window: what git says about the focused
 * session's folder on the left, the running version on the right.
 *
 * Unlike the working directory — which lives in the conversation itself,
 * because `cwd` is per-tab state that would re-render every mounted tab if
 * `App` held it — this needs nothing `App` doesn't already have: the relay resolves the
 * folder from the session id, so the id of the focused tab is the whole
 * input. Rendering it straight from `App` is both simpler and cheaper here.
 *
 * Nothing polls. The answer is re-asked on the three events that can change
 * it — the focused session, its turn state, and the window regaining focus
 * — because every ask spawns a `git status` on the host, and a timer doing
 * that in the background for a folder nobody is looking at is exactly the
 * kind of cost this redesign is not allowed to add.
 */
export function StatusBar({
  profile,
  sessionId,
  isRunning,
  windowFocused,
  connected,
  onOpenUpdateModal,
  backgroundActivity,
  onOpenBackgroundActivityItem,
  onStopBackgroundActivityItem,
  onDismissBackgroundActivityItem,
  onStopAllBackgroundActivity,
}: StatusBarProps) {
  const dict = useDict();
  const update = useAppUpdate();
  const downloaded = useDownloadedUpdate();
  const profileId = profile?.id ?? null;
  const key = profileId && sessionId ? `${profileId}:${sessionId}` : null;

  const [activityOpen, setActivityOpen] = useState(false);
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  const activityStrings = dict.shell.statusBar.backgroundActivity;
  const rooms = totalRoomStatuses(useRoomStatuses().values());
  const runCount = backgroundActivity.filter((item) => item.status === "run").length + rooms.working;
  const failCount = backgroundActivity.filter((item) => item.status === "fail").length + rooms.failed;
  const needYouCount = rooms.needsYou;
  const [repo, setRepo] = useState<RepoState>(null);
  const [shownKey, setShownKey] = useState<string | null>(key);

  // Switching tabs has to drop the previous folder's line immediately —
  // painting one session's branch under another one's conversation, even
  // for the length of a request, is worse than painting nothing. Adjusting
  // it here rather than in an effect is what keeps a tab switch costing the
  // same number of commits it cost before this bar existed: React re-renders
  // this component in place, without committing a second pass over the tree.
  if (key !== shownKey) {
    setShownKey(key);
    setRepo(null);
  }

  useEffect(() => {
    if (!profile || !sessionId || !windowFocused) return;
    let cancelled = false;

    getGitStatus(profile, sessionId)
      .then((status) => {
        if (!cancelled) setRepo((prev) => (status.repo && !sameRepo(prev, status) ? status : prev));
      })
      .catch(() => {
        // A machine that's asleep, a relay too old for the route, a host
        // without git: all of them mean the same thing here — no repository
        // to describe — and none of them belong in a strip with no way to
        // dismiss a message.
        if (!cancelled) setRepo((prev) => (prev === null ? prev : null));
      });

    return () => {
      cancelled = true;
    };
    // `profile` is a fresh object on most of `App`'s renders; its id is what
    // actually decides which machine gets asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, sessionId, isRunning, windowFocused]);

  const changes =
    repo === null
      ? null
      : repo.changes === 0
        ? dict.shell.statusBar.clean
        : repo.changes === 1
          ? dict.shell.statusBar.changesOne
          : dict.shell.statusBar.changes.replace("{count}", String(repo.changes));

  return (
    <div data-status-bar className="flex h-7 shrink-0 items-center gap-3.5 border-t border-border-soft bg-bg-chrome pr-2 pl-2.5 font-mono text-[11.5px] text-text-faint">
      <DropdownMenu
        modal={false}
        open={activityOpen}
        onOpenChange={(next) => {
          setActivityOpen(next);
          if (!next) activityTriggerRef.current?.blur();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={activityTriggerRef}
            type="button"
            title={activityStrings.chipTitle}
            // Same wash as `LanguageControl` on the other end of this bar and
            // as the composer's menu triggers: no outline, only a fill that
            // appears on hover and while the menu is open.
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 outline-hidden transition-colors hover:bg-surface-hover hover:text-foreground",
              activityOpen ? "bg-surface-hover text-foreground" : "text-text-faint",
            )}
          >
            {runCount > 0 ? (
              <span className="size-2.5 shrink-0 animate-spin rounded-full border border-border border-t-primary" />
            ) : (
              <span className="size-2 shrink-0 rounded-full border border-text-faint" />
            )}
            <span className="whitespace-nowrap">{runCount > 0 ? activityStrings.running.replace("{count}", String(runCount)) : activityStrings.none}</span>
            {needYouCount > 0 && (
              <>
                <span className="ml-1.5 size-[7px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <span className="whitespace-nowrap text-primary-ink">{activityStrings.needYou.replace("{count}", String(needYouCount))}</span>
              </>
            )}
            {failCount > 0 && (
              <>
                <span className="ml-1.5 size-[7px] shrink-0 border border-destructive" aria-hidden="true" />
                <span className="whitespace-nowrap text-destructive">{activityStrings.failedSuffix.replace("{count}", String(failCount))}</span>
              </>
            )}
            <span className="text-[8px] opacity-60">{activityOpen ? "▾" : "▴"}</span>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-[416px]">
          <DropdownMenuLabel>{activityStrings.heading}</DropdownMenuLabel>

          {backgroundActivity.length > 0 ? (
            <div className="max-h-[326px] overflow-y-auto">
              {backgroundActivity.map((item) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  onOpen={() => {
                    onOpenBackgroundActivityItem(item);
                    setActivityOpen(false);
                  }}
                  onStop={() => onStopBackgroundActivityItem(item)}
                  onDismiss={() => onDismissBackgroundActivityItem(item)}
                />
              ))}
            </div>
          ) : (
            <p className="px-3 py-2 font-sans text-[13px] text-text-faint">{activityStrings.emptyTitle}</p>
          )}

          {runCount > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={(event) => {
                // Stopping everything leaves the list open to show it empty.
                event.preventDefault();
                onStopAllBackgroundActivity();
              }}>
                {activityStrings.stopAll}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />

      {repo && (
        <span className="truncate" title={repo.detached ? dict.shell.statusBar.detachedHead : undefined}>
          {repo.branch} · {changes}
        </span>
      )}
      {connected !== undefined && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 px-1.5" role="status">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", connected ? "bg-diff-add" : "animate-pulse bg-destructive")}
          />
          {connected ? dict.shell.statusBar.relayConnected : dict.shell.titleBar.reconnecting}
        </span>
      )}
      {downloaded ? (
        <button
          type="button"
          onClick={onOpenUpdateModal}
          className="flex shrink-0 cursor-pointer items-center gap-1 border border-transparent px-1.5 py-0.5 text-primary outline-hidden transition-colors hover:border-border"
          title={dict.shell.statusBar.updateReady.replace("{version}", downloaded.version)}
        >
          <ArrowUpCircle className="size-3" strokeWidth={1.5} />
          {dict.shell.statusBar.updateReady.replace("{version}", downloaded.version)}
        </button>
      ) : update ? (
        <button
          type="button"
          onClick={onOpenUpdateModal}
          className="flex shrink-0 cursor-pointer items-center gap-1 border border-transparent px-1.5 py-0.5 text-primary outline-hidden transition-colors hover:border-border"
          title={dict.shell.statusBar.updateAvailable.replace("{version}", update.version)}
        >
          <ArrowUpCircle className="size-3" strokeWidth={1.5} />
          {dict.shell.statusBar.updateAvailable.replace("{version}", update.version)}
        </button>
      ) : (
        <span className="shrink-0" title={dict.shell.statusBar.appVersion.replace("{version}", APP_VERSION)}>
          v{APP_VERSION}
        </span>
      )}
      <LanguageControl />
    </div>
  );
}
