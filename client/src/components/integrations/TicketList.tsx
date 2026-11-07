import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Equal, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDict, useLocale } from "@/i18n";
import { formatCompactTime } from "@/lib/format/relativeTime";
import { priorityLevel, type PriorityLevel } from "@/lib/integrations/tickets";
import type { TicketRow } from "@/lib/integrations/model";
import { cn } from "@/lib/utils";

const PRIORITY_ICON: Record<PriorityLevel, typeof ChevronUp> = {
  highest: ChevronsUp,
  high: ChevronUp,
  medium: Equal,
  low: ChevronDown,
  lowest: ChevronsDown,
  none: Minus,
};

const PRIORITY_TONE: Record<PriorityLevel, string> = {
  highest: "text-destructive",
  high: "text-destructive",
  medium: "text-warn",
  low: "text-muted-foreground",
  lowest: "text-muted-foreground",
  none: "text-text-faint",
};

/** A ticket's priority as a mark, its word in the tooltip and for readers. */
export function PriorityMark({ priority, className }: { priority: string | undefined; className?: string }) {
  if (!priority) return null;
  const level = priorityLevel(priority);
  const Icon = PRIORITY_ICON[level];
  return (
    <span title={priority} className={cn("inline-flex shrink-0", PRIORITY_TONE[level], className)}>
      <Icon className="size-3.5" strokeWidth={2.25} aria-hidden />
      <span className="sr-only">{priority}</span>
    </span>
  );
}

interface TicketListProps {
  rows: readonly TicketRow[];
  /** The list is the relay's last answer while it cannot be reached. */
  stale: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onOpen: (key: string) => void;
  onLoadMore: () => void;
}

/** The tickets of the list, newest change first: title, then priority, key,
 * status and how long since it changed. A row opens the ticket's screen. */
export function TicketList({ rows, stale, hasMore, loadingMore, onOpen, onLoadMore }: TicketListProps) {
  const copy = useDict().integrations.tickets;
  const { locale } = useLocale();
  const count = hasMore ? copy.countMore.replace("{count}", String(rows.length)) : rows.length === 1 ? copy.countOne : copy.count.replace("{count}", String(rows.length));
  return (
    <div className={cn("flex flex-col", stale && "opacity-60")}>
      <ul data-testid="ticket-list" className="flex flex-col">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              onClick={() => onOpen(row.key)}
              data-ticket={row.key}
              className="flex w-full cursor-pointer flex-col gap-1 px-1 py-2 text-left transition-colors hover:bg-surface-hover"
            >
              <span className="line-clamp-2 text-[14px] leading-snug text-foreground">{row.title}</span>
              <span className="flex min-w-0 items-center gap-2 font-mono text-[11.5px]">
                <PriorityMark priority={row.priority} />
                <span className="shrink-0 text-primary">{row.key}</span>
                <span className="min-w-0 truncate text-text-faint">{row.statusLabel}</span>
                <span className="ml-auto shrink-0 text-text-faint">{formatCompactTime(row.updatedAt, locale)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-3 px-1">
        <span className="font-mono text-[11px] text-text-faint">{count}</span>
        {hasMore && (
          <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={loadingMore || stale} aria-busy={loadingMore} onClick={onLoadMore}>
            {loadingMore && <span aria-hidden className="size-3 animate-spin rounded-full border-[1.5px] border-border border-t-primary" />}
            {copy.loadMore}
          </Button>
        )}
      </div>
    </div>
  );
}
