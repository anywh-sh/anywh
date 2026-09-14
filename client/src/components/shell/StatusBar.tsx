import { useEffect, useState } from "react";

import { LanguageControl } from "@/components/shell/LanguageControl";
import { useDict } from "@/i18n";
import { APP_VERSION } from "@/lib/appVersion";
import { getGitStatus } from "@/lib/gitClient";
import type { Profile } from "@/lib/profiles";

interface StatusBarProps {
  /** The focused tab's profile — `null` with no tab open at all. */
  profile: Profile | null;
  /** The focused tab's id, which is also its session id relay-side. */
  sessionId: string | null;
  /** Whether that session is mid-turn. Not displayed: it is here because a
   * turn is the most likely thing to have changed the folder. */
  isRunning: boolean;
  windowFocused: boolean;
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
export function StatusBar({ profile, sessionId, isRunning, windowFocused }: StatusBarProps) {
  const dict = useDict();
  const profileId = profile?.id ?? null;
  const key = profileId && sessionId ? `${profileId}:${sessionId}` : null;

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
      {repo && (
        <span className="truncate" title={repo.detached ? dict.shell.statusBar.detachedHead : undefined}>
          {repo.branch} · {changes}
        </span>
      )}
      <span className="ml-auto shrink-0" title={dict.shell.statusBar.appVersion.replace("{version}", APP_VERSION)}>
        v{APP_VERSION}
      </span>
      <LanguageControl />
    </div>
  );
}
