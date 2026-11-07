import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionListCache } from "@/hooks/tabs/useMergedSessions";
import { useDict, useLocale } from "@/i18n";
import { formatCompactTime } from "@/lib/format/relativeTime";
import type { WorkTicket } from "@/lib/integrations/model";
import { chipsOf } from "@/lib/integrations/workTickets";
import type { SessionSummary } from "@/lib/relay/relay-types";
import { cn } from "@/lib/utils";

/** How many sessions a list row names before "+N". */
const ROW_CHIPS = 2;

/** One profile's sessions by id, from the session list this device keeps:
 * the titles and what each is doing, whether or not it is open in a tab. */
function useProfileSessions(profileId: string): Map<string, SessionSummary> {
  const cache = useSessionListCache();
  const sessions = cache[profileId]?.sessions;
  return useMemo(() => new Map((sessions ?? []).map((session) => [session.id, session])), [sessions]);
}

/** What a session is doing, in the sidebar's own glyphs: the orange dot
 * while it waits for the person, the spinner while a turn runs, a quiet
 * square otherwise. */
export function SessionActivityMark({ session }: { session: SessionSummary | undefined }) {
  const dict = useDict();
  if (session?.activity === "awaiting") {
    return <span role="img" aria-label={dict.shell.sidebar.sessionNeedsYou} data-activity="awaiting" className="size-1.5 shrink-0 rounded-full bg-primary" />;
  }
  if (session?.activity === "running") {
    return <Loader2 role="img" aria-label={dict.shell.sidebar.agentWorking} data-activity="running" className="size-3 shrink-0 animate-spin text-foreground" />;
  }
  return <span aria-hidden data-activity="idle" className="size-1.5 shrink-0 border border-text-faint" />;
}

/** The sessions on a ticket's list row: the first two by name, with their
 * activity, and how many more. Inert — the row itself opens the ticket. */
export function SessionLinkChips({ profileId, links }: { profileId: string; links: readonly WorkTicket[] }) {
  const dict = useDict();
  const sessions = useProfileSessions(profileId);
  if (links.length === 0) return null;
  const { shown, more } = chipsOf(links, ROW_CHIPS);
  return (
    <span data-testid="session-link-chips" className="flex min-w-0 items-center gap-2 font-sans text-[12px] text-muted-foreground">
      {shown.map((link) => {
        const session = sessions.get(link.sessionId);
        return (
          <span key={link.sessionId} data-session-chip={link.sessionId} className="flex min-w-0 items-center gap-1.5">
            <span className="max-w-[9rem] truncate">{session?.title ?? dict.common.untitledSession}</span>
            <SessionActivityMark session={session} />
          </span>
        );
      })}
      {more > 0 && <span className="shrink-0 font-mono text-[11px] text-text-faint">{dict.integrations.work.moreSessions.replace("{count}", String(more))}</span>}
    </span>
  );
}

/** A ticket screen's "Sessions": every session that works on it, each one
 * opening that session. */
export function TicketSessions({
  profileId,
  links,
  onOpen,
}: {
  profileId: string;
  links: readonly WorkTicket[];
  onOpen: (sessionId: string, title: string | null) => void;
}) {
  const dict = useDict();
  const { locale } = useLocale();
  const copy = dict.integrations.work;
  const sessions = useProfileSessions(profileId);
  return (
    <section data-testid="ticket-sessions" className="mt-6">
      <h3 className="flex items-center gap-2 font-mono text-[11.5px] text-text-faint">
        {copy.sessions}
        <span aria-hidden className="h-px flex-1 border-t border-dashed border-border" />
        {links.length}
      </h3>
      {links.length === 0 ? (
        <p className="mt-2 text-sm text-text-faint">{copy.noSessions}</p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {links.map((link) => {
            const session = sessions.get(link.sessionId);
            return (
              <li key={link.sessionId}>
                <button
                  type="button"
                  data-session-link={link.sessionId}
                  onClick={() => onOpen(link.sessionId, session?.title ?? null)}
                  className="flex w-full cursor-pointer items-center gap-2.5 px-1 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover"
                >
                  <span className="flex w-3 shrink-0 justify-center">
                    <SessionActivityMark session={session} />
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", session ? "text-foreground" : "text-muted-foreground")}>{session?.title ?? dict.common.untitledSession}</span>
                  {session?.lastActiveAt != null && <span className="shrink-0 font-mono text-[11px] text-text-faint">{formatCompactTime(session.lastActiveAt, locale)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Pinned under a ticket's screen: "Work on this in the current session"
 * when the tab's session is free to take it, and "New session" always. */
export function TicketWorkActions({ workHere, onWorkHere, onNewSession }: { workHere: boolean; onWorkHere: () => void; onNewSession: (() => void) | null }) {
  const copy = useDict().integrations.work;
  if (!onNewSession && !workHere) return null;
  return (
    <div data-testid="ticket-work-actions" className="flex shrink-0 gap-2 border-t border-border-soft px-3 py-3">
      {workHere && (
        <Button type="button" className="min-w-0 flex-1" onClick={onWorkHere}>
          <span className="truncate">{copy.workHere}</span>
        </Button>
      )}
      {onNewSession && (
        <Button type="button" variant="outline" className={cn(!workHere && "flex-1")} onClick={onNewSession}>
          {copy.newSession}
        </Button>
      )}
    </div>
  );
}
