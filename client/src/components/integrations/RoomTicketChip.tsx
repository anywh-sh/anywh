import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useProfileIntegrations } from "@/hooks/relay/useIntegrations";
import { useDict } from "@/i18n";
import type { TicketStatusCategory, TicketTag } from "@/lib/integrations/model";
import { ticketView } from "@/lib/integrations/tickets";
import { cn } from "@/lib/utils";

/** What the profile's cache knows of a ticket: its title and where it
 * stands, when it was read. */
export function useCachedTicket(profileId: string, ticket: TicketTag): { title?: string; statusCategory?: TicketStatusCategory; statusLabel?: string } {
  const integrations = useProfileIntegrations(profileId);
  const integration = integrations?.entry.integrations?.find((entry) => entry.provider === ticket.provider);
  const { row } = ticketView(integration, ticket.key);
  return row ? { title: row.title, statusCategory: row.statusCategory, statusLabel: row.statusLabel } : {};
}

/** Where a ticket stands as a dot: hollow to do, filled in progress, green done. */
export function TicketStatusDot({ category, label }: { category: TicketStatusCategory; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-status-category={category}
      className={cn("size-1.5 shrink-0 rounded-full", category === "todo" ? "border border-text-faint" : category === "doing" ? "bg-primary" : "bg-diff-add")}
    />
  );
}

/**
 * The ticket a room's agent works on, on its card: the tracker's mark, the
 * key and, when the cache knows it, where the ticket stands. A click opens
 * the ticket's screen where there is a pane for it.
 */
export function RoomTicketChip({ profileId, ticket, onOpen }: { profileId: string; ticket: TicketTag & { title?: string }; onOpen?: () => void }) {
  const dict = useDict();
  const cached = useCachedTicket(profileId, ticket);
  const title = ticket.title ?? cached.title;
  const body = (
    <>
      <IntegrationIcon provider={ticket.provider} className="size-3 shrink-0 text-primary" />
      <span>{ticket.key}</span>
      {cached.statusCategory && <TicketStatusDot category={cached.statusCategory} label={cached.statusLabel} />}
    </>
  );
  const className = "sala-ticket";
  return onOpen ? (
    <button type="button" data-nodrag data-testid="room-ticket-chip" data-ticket={ticket.key} className={cn(className, "on")} title={title} aria-label={dict.integrations.work.openTicket.replace("{key}", ticket.key)} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <span data-testid="room-ticket-chip" data-ticket={ticket.key} className={className} title={title}>
      {body}
    </span>
  );
}
