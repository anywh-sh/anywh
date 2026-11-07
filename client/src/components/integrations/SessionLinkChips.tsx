import { useMemo } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RoomGlyph } from "@/components/sala/SalaIcons";
import { useSessionListCache } from "@/hooks/tabs/useMergedSessions";
import { useDict, useLocale } from "@/i18n";
import { formatCompactTime } from "@/lib/format/relativeTime";
import type { WorkTicket, WorkTicketPlace } from "@/lib/integrations/model";
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

/** The profile's rooms, as its session list has them, the latest active first. */
export function useProfileRooms(profileId: string): TicketRoomChoice[] {
  const cache = useSessionListCache();
  const sessions = cache[profileId]?.sessions;
  return useMemo(
    () =>
      (sessions ?? [])
        .filter((session) => session.room === true)
        .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
        .map((session) => ({ id: session.id, title: session.title })),
    [sessions],
  );
}

/** What a session is doing, in the sidebar's own glyphs: the orange dot
 * while it waits for the person, the spinner while a turn runs, nothing
 * otherwise. */
export function SessionActivityMark({ session }: { session: Pick<SessionSummary, "activity"> | undefined }) {
  const dict = useDict();
  if (session?.activity === "awaiting") {
    return <span role="img" aria-label={dict.shell.sidebar.sessionNeedsYou} data-activity="awaiting" className="size-1.5 shrink-0 rounded-full bg-primary" />;
  }
  if (session?.activity === "running") {
    return <Loader2 role="img" aria-label={dict.shell.sidebar.agentWorking} data-activity="running" className="size-3 shrink-0 animate-spin text-foreground" />;
  }
  return null;
}

/** The sessions on a ticket's list row: the first two by name (a room's
 * agent by its own, since workers are not in the session list), with their
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
            <span className="max-w-[9rem] truncate">{session?.title || link.place?.agentTitle || (link.place ? dict.sala.card.untitled : dict.common.untitledSession)}</span>
            <SessionActivityMark session={session ?? (link.place ? { activity: placeActivity(link.place.agentState) } : undefined)} />
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
  onOpenRoomAgent,
}: {
  profileId: string;
  links: readonly WorkTicket[];
  onOpen: (sessionId: string, title: string | null) => void;
  /** A room's agent: its room, with the agent in view. */
  onOpenRoomAgent: (roomId: string, roomTitle: string | null, agentId: string) => void;
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
            const place = link.place;
            if (place) {
              return (
                <li key={link.sessionId}>
                  <RoomAgentRow place={place} agentId={link.sessionId} onOpen={() => onOpenRoomAgent(place.roomId, place.roomTitle || null, link.sessionId)} />
                </li>
              );
            }
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

/** What a room agent's state looks like in the session rows' glyphs. */
function placeActivity(state: string): SessionSummary["activity"] {
  if (state === "working") return "running";
  if (state === "awaiting_user") return "awaiting";
  return undefined;
}

/** A room's agent on a ticket's screen: "<room> › <agent>" and its state. */
function RoomAgentRow({ place, agentId, onOpen }: { place: WorkTicketPlace; agentId: string; onOpen: () => void }) {
  const dict = useDict();
  const copy = dict.integrations.work;
  const state = (copy.agentStates as Record<string, string>)[place.agentState] ?? place.agentState;
  const label = copy.roomAgent.replace("{room}", place.roomTitle || copy.untitledRoom).replace("{agent}", place.agentTitle || dict.sala.card.untitled);
  return (
    <button
      type="button"
      data-room-agent-link={agentId}
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-2.5 px-1 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-hover"
    >
      <span className="flex w-3 shrink-0 justify-center">
        <SessionActivityMark session={{ activity: placeActivity(place.agentState) }} />
      </span>
      <RoomGlyph size={13} />
      <span className="min-w-0 flex-1 truncate text-foreground" title={label}>
        {label}
      </span>
      <span data-agent-state={place.agentState} className="shrink-0 font-mono text-[11px] text-text-faint">
        {state}
      </span>
    </button>
  );
}

/** A room "Work on it in a room…" can hand a ticket to. */
export interface TicketRoomChoice {
  id: string;
  title: string | null;
}

/** Pinned under a ticket's screen: "Work on this in the current session"
 * when the tab's session is free to take it, "New session" always, and "Work
 * on it in a room…" with the profile's rooms and a new one. */
export function TicketWorkActions({
  workHere,
  onWorkHere,
  onNewSession,
  rooms,
  onWorkInRoom,
}: {
  workHere: boolean;
  onWorkHere: () => void;
  onNewSession: (() => void) | null;
  rooms: readonly TicketRoomChoice[];
  /** `null` room: a new one. Absent while the ticket cannot be handed over. */
  onWorkInRoom: ((room: TicketRoomChoice | null) => void) | null;
}) {
  const copy = useDict().integrations.work;
  if (!onNewSession && !workHere && !onWorkInRoom) return null;
  return (
    <div data-testid="ticket-work-actions" className="flex shrink-0 flex-col gap-2 border-t border-border-soft px-3 py-3">
      <div className="flex gap-2">
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
      {onWorkInRoom && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="w-full justify-between">
              <span className="flex min-w-0 items-center gap-2">
                <RoomGlyph size={14} />
                <span className="truncate">{copy.workInRoom}</span>
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-text-faint" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            {rooms.map((room) => (
              <DropdownMenuItem key={room.id} data-room-choice={room.id} onSelect={() => onWorkInRoom(room)} className="gap-2">
                <RoomGlyph size={13} />
                <span className="min-w-0 flex-1 truncate">{room.title ?? copy.untitledRoom}</span>
              </DropdownMenuItem>
            ))}
            {rooms.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem data-room-choice="new" onSelect={() => onWorkInRoom(null)} className="gap-2">
              <Plus className="size-3.5" aria-hidden />
              <span>{copy.newRoom}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
