import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LanguageControl } from "@/components/shell/LanguageControl";
import { useAppUpdate, useDownloadedUpdate } from "@/hooks/platform/useAppUpdate";
import {
  backgroundActivityProfileColor,
  backgroundActivityProfileName,
  type BackgroundActivityItem,
} from "@/hooks/useBackgroundActivity";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/install/appVersion";
import { getGitStatus } from "@/lib/relay/gitClient";
import { formatDurationLong, cn } from "@/lib/utils";
import type { Profile } from "@/lib/profiles/profiles";

interface StatusBarProps {
  /** The focused tab's profile — `null` with no tab open at all. */
  profile: Profile | null;
  /** The focused tab's id, which is also its session id relay-side. */
  sessionId: string | null;
  /** Whether that session is mid-turn. Not displayed: it is here because a
   * turn is the most likely thing to have changed the folder. */
  isRunning: boolean;
  windowFocused: boolean;
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
  const elapsedSeconds = useElapsedSeconds(item.time);
  const failed = item.status === "fail";
  const tail = item.kind === "agent" ? strings.agentTail : item.tail;

  return (
    <div className="group relative flex items-start gap-2.5 py-2.5 pr-2.5 pl-3.5 transition-colors hover:bg-bg-elevated">
      <span
        className="absolute top-2.5 bottom-2.5 left-1 w-0.5 opacity-80"
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
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-foreground">{item.name}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-text-faint">
            {failed ? strings.timeAgo.replace("{time}", formatDurationLong(elapsedSeconds)) : formatDurationLong(elapsedSeconds)}
          </span>
        </div>
        {tail && <div className={cn("truncate font-mono text-[10.5px]", failed ? "text-destructive" : "text-text-faint")}>{tail}</div>}
        <div className="flex items-center gap-1.5">
          <span
            className="max-w-24 shrink-0 truncate border-l-2 pl-1.5 font-mono text-[10px] text-muted-foreground"
            style={{ borderColor: backgroundActivityProfileColor(item) }}
          >
            {backgroundActivityProfileName(item)}
          </span>
          <div className="flex flex-1 items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {failed ? (
              <button
                type="button"
                onClick={onDismiss}
                className="cursor-pointer border border-border px-1.5 py-0.5 font-mono text-[10px] font-medium text-text-faint transition-colors hover:border-text-faint hover:text-foreground"
              >
                {strings.dismiss}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onOpen}
                  className="cursor-pointer border border-border px-1.5 py-0.5 font-mono text-[10px] font-medium text-text-faint transition-colors hover:border-text-faint hover:text-foreground"
                >
                  {strings.open}
                </button>
                <button
                  type="button"
                  onClick={onStop}
                  className="cursor-pointer border border-destructive px-1.5 py-0.5 font-mono text-[10px] font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
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
 * Unlike the working directory — which lives in the title bar but is
 * published there through a portal, because `cwd` is per-tab state that
 * would re-render every mounted tab if `App` held it (see titleBarSlot.ts) —
 * this needs nothing `App` doesn't already have: the relay resolves the
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
  const runCount = backgroundActivity.filter((item) => item.status === "run").length;
  const failCount = backgroundActivity.filter((item) => item.status === "fail").length;
  const activitySummary =
    (runCount > 0 ? activityStrings.running.replace("{count}", String(runCount)) : activityStrings.none) +
    (failCount > 0 ? ` · ${activityStrings.failedSuffix.replace("{count}", String(failCount))}` : "");

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
    <div className="flex h-[26px] shrink-0 items-center gap-3.5 border-t border-border-soft bg-bg-chrome px-3 font-mono text-[10.5px] text-text-faint">
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
            className={cn(
              "flex h-[18px] shrink-0 cursor-pointer items-center gap-1.5 px-1.5 transition-colors",
              activityOpen
                ? "border border-border bg-popover text-foreground"
                : "border border-transparent text-text-faint hover:text-muted-foreground",
            )}
          >
            {runCount > 0 ? (
              <span className="size-2.5 shrink-0 animate-spin rounded-full border border-border border-t-primary" />
            ) : (
              <span className="size-2 shrink-0 rounded-full border border-text-faint" />
            )}
            <span className="whitespace-nowrap">{activitySummary}</span>
            {failCount > 0 && <span className="size-[5px] shrink-0 bg-destructive" aria-hidden="true" />}
            <span className="text-[8px] opacity-60">{activityOpen ? "▾" : "▴"}</span>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-[416px] p-0">
          <div className="flex items-center gap-2 border-b border-border-soft px-[11px] py-[10px]">
            <span className="flex-1 font-mono text-[10px] font-medium tracking-[0.14em] text-text-faint uppercase">
              {activityStrings.heading}
            </span>
            <button
              type="button"
              onClick={() => {
                setActivityOpen(false);
                activityTriggerRef.current?.blur();
              }}
              aria-label={activityStrings.close}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center text-text-faint transition-colors hover:text-foreground"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>

          {backgroundActivity.length > 0 ? (
            <div className="max-h-[326px] overflow-y-auto py-1">
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
            <div className="flex flex-col items-center gap-2 px-4 py-7 text-center">
              <span className="flex size-[30px] items-center justify-center border border-dashed border-border font-mono text-xs text-text-faint">
                ○
              </span>
              <span className="font-mono text-[11.5px] text-muted-foreground">{activityStrings.emptyTitle}</span>
              <span className="max-w-[236px] text-xs leading-relaxed text-text-faint">{activityStrings.emptyDescription}</span>
            </div>
          )}

          {runCount > 0 && (
            <div className="flex items-center justify-end border-t border-border-soft px-[9px] py-2">
              <button
                type="button"
                onClick={onStopAllBackgroundActivity}
                className="cursor-pointer border border-destructive px-1.5 py-1 font-mono text-[10px] font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
              >
                {activityStrings.stopAll}
              </button>
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />

      {repo && (
        <span className="truncate" title={repo.detached ? dict.shell.statusBar.detachedHead : undefined}>
          {repo.branch} · {changes}
        </span>
      )}
      {downloaded ? (
        <button
          type="button"
          onClick={onOpenUpdateModal}
          className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 border border-transparent px-1.5 py-0.5 text-primary outline-hidden transition-colors hover:border-border"
          title={dict.shell.statusBar.updateReady.replace("{version}", downloaded.version)}
        >
          <ArrowUpCircle className="size-3" strokeWidth={1.5} />
          {dict.shell.statusBar.updateReady.replace("{version}", downloaded.version)}
        </button>
      ) : update ? (
        <button
          type="button"
          onClick={onOpenUpdateModal}
          className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 border border-transparent px-1.5 py-0.5 text-primary outline-hidden transition-colors hover:border-border"
          title={dict.shell.statusBar.updateAvailable.replace("{version}", update.version)}
        >
          <ArrowUpCircle className="size-3" strokeWidth={1.5} />
          {dict.shell.statusBar.updateAvailable.replace("{version}", update.version)}
        </button>
      ) : (
        <span className="ml-auto shrink-0" title={dict.shell.statusBar.appVersion.replace("{version}", APP_VERSION)}>
          v{APP_VERSION}
        </span>
      )}
      <LanguageControl />
    </div>
  );
}
