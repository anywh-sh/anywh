import { useDict } from "@/i18n";
import type { MessageTicketRef } from "@/lib/relay/agent-event";
import type { TicketTag } from "@/lib/integrations/model";

interface MessageTicketChipProps {
  ticket: MessageTicketRef;
  /** Opens the ticket's screen; absent where there is no pane to open (iOS,
   * compact), and the chip is drawn the same but does nothing. */
  onShowTicket?: (ticket: TicketTag) => void;
}

/** A ticket the person put in their message with `#`, drawn in the sent
 * bubble the way the composer drew it. */
export function MessageTicketChip({ ticket, onShowTicket }: MessageTicketChipProps) {
  const dict = useDict();
  const tooltip = ticket.title || ticket.key;
  if (!onShowTicket) {
    return (
      <span data-testid="message-ticket-chip" data-provider={ticket.provider} className="composer-ticket-chip" title={tooltip}>
        {ticket.key}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="message-ticket-chip"
      data-provider={ticket.provider}
      className="composer-ticket-chip cursor-pointer transition-colors hover:bg-primary/15"
      title={tooltip}
      aria-label={dict.integrations.work.openTicket.replace("{key}", ticket.key)}
      onClick={() => onShowTicket({ provider: ticket.provider, key: ticket.key })}
    >
      {ticket.key}
    </button>
  );
}
