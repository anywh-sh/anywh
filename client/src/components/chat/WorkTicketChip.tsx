import { useEffect } from "react";
import { X } from "lucide-react";
import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useSessionListCache } from "@/hooks/tabs/useMergedSessions";
import { useDict } from "@/i18n";
import { integrationDataState } from "@/lib/integrations/derive";
import type { TicketRef, TicketTag } from "@/lib/integrations/model";
import { sessionTicket } from "@/lib/integrations/workTickets";
import { isIOS } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

interface WorkTicketChipProps {
  ticket: TicketTag & { title?: string };
  /** Opens the ticket's screen; absent where there is no pane to open. */
  onOpen?: () => void;
  /** The ✕; absent when nothing can be undone from here. */
  onRemove?: () => void;
  removeLabel: string;
}

/**
 * The ticket a session works on — or, on the new-session screen, the one its
 * first message will start it on — beside the folder in the composer's info
 * strip: the tracker's mark and the key, opening the ticket's screen, and a
 * ✕ that lets go of it.
 */
export function WorkTicketChip({ ticket, onOpen, onRemove, removeLabel }: WorkTicketChipProps) {
  const dict = useDict();
  const label = dict.integrations.work.openTicket.replace("{key}", ticket.key);
  const body = (
    <>
      <IntegrationIcon provider={ticket.provider} className="size-3.5 shrink-0 text-primary" />
      <span className="truncate">{ticket.key}</span>
    </>
  );
  return (
    <span
      data-testid="work-ticket-chip"
      data-ticket={ticket.key}
      title={ticket.title}
      className={cn(
        "flex min-w-0 shrink-0 items-center border border-border font-mono text-foreground",
        isIOS() ? "h-[26px] bg-bg-sidebar text-[11.5px]" : "h-[calc(24px*var(--chrome-scale))] text-[length:calc(11.5px*var(--chrome-scale))]",
      )}
    >
      {onOpen ? (
        <button type="button" aria-label={label} onClick={onOpen} className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 pr-1 pl-2 transition-colors hover:text-primary">
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 pr-1 pl-2">{body}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="flex h-full cursor-pointer items-center px-1.5 text-text-faint transition-colors hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : (
        <span aria-hidden className="w-1.5" />
      )}
    </span>
  );
}

interface SessionWorkTicketProps {
  profileId: string;
  sessionId: string;
  /** The ticket a new session's first message will start it on. */
  pendingTicket: TicketRef | null;
  onClearPending: () => void;
  /** Sent with the first message, until the relay says the session works on
   * it (or the turn ended without it saying so). */
  startedTicket: TicketRef | null;
  onStartedSettled: () => void;
  turnInFlight: boolean;
  onShowTicket?: (ticket: TicketTag) => void;
}

/**
 * The chip of one session, in the same place before and after its first
 * message: the pending ticket of a new session (✕ only forgets it), then the
 * session's work ticket — from the profile's integrations socket, or from the
 * session list where there is none (✕ only works through that socket).
 *
 * Its own component so the integrations state, which every pushed change
 * re-renders, reaches this chip and not the whole conversation.
 */
export function SessionWorkTicket({ profileId, sessionId, pendingTicket, onClearPending, startedTicket, onStartedSettled, turnInFlight, onShowTicket }: SessionWorkTicketProps) {
  const dict = useDict();
  const copy = dict.integrations.work;
  const integrations = useProfileIntegrations(profileId);
  const cache = useSessionListCache();
  const fromList = cache[profileId]?.sessions.find((session) => session.id === sessionId)?.workTicket;
  const links = integrations?.entry.workTickets ?? null;
  const linked = sessionTicket(links, sessionId, fromList);
  const canUnlink = integrations !== null && links !== null && integrationDataState(integrations.entry) === "live";

  // The relay links the session as its first turn starts; by the time that
  // turn ends it has said so, or it did not take the ticket.
  useEffect(() => {
    if (startedTicket && (linked || !turnInFlight)) onStartedSettled();
  }, [startedTicket, linked, turnInFlight, onStartedSettled]);

  const unlink = canUnlink
    ? () => {
        integrations.send({ type: "work_ticket", sessionId, action: "unlink" });
        onStartedSettled();
      }
    : undefined;

  if (pendingTicket) {
    return <WorkTicketChip ticket={pendingTicket} onOpen={onShowTicket && (() => onShowTicket(pendingTicket))} onRemove={onClearPending} removeLabel={copy.dropPending.replace("{key}", pendingTicket.key)} />;
  }
  const ticket = linked ?? startedTicket;
  if (!ticket) return null;
  return <WorkTicketChip ticket={ticket} onOpen={onShowTicket && (() => onShowTicket(ticket))} onRemove={unlink} removeLabel={copy.unlink.replace("{key}", ticket.key)} />;
}
