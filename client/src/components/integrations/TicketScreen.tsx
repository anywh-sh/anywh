import type { ReactNode } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { PriorityMark } from "@/components/integrations/TicketList";
import { useDict, useLocale } from "@/i18n";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format/relativeTime";
import type { TicketDetail, TicketRow } from "@/lib/integrations/model";

interface TicketScreenProps {
  ticketKey: string;
  /** Its own read, once it landed. */
  detail?: TicketDetail;
  /** What a list knows of it, shown until the read lands. */
  row?: TicketRow;
  /** The list it came from, for the way back ("All mine", "NGL"). */
  listName: string;
  providerName: string;
  /** Above the screen: the refresh control and how fresh the data is. */
  toolbar: ReactNode;
  /** In place of the description while nothing has been read. */
  placeholder?: ReactNode;
  /** The sessions that work on the ticket, between its description and its
   * comments. */
  sessions?: ReactNode;
  /** Actions pinned under the screen. */
  footer?: ReactNode;
  onBack: () => void;
}

/**
 * One ticket, in the integration's pane in place of the list: title, key,
 * priority and status, the description in the chat's own markdown, and the
 * latest comments, oldest first. "Open in Jira" leaves for the tracker.
 */
export function TicketScreen({ ticketKey, detail, row, listName, providerName, toolbar, placeholder, sessions, footer, onBack }: TicketScreenProps) {
  const copy = useDict().integrations.tickets.ticket;
  const { locale } = useLocale();
  const shown = detail ?? row;
  const url = shown?.url;

  return (
    <div data-testid="ticket-screen" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="flex min-w-0 cursor-pointer items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{copy.back.replace("{list}", listName)}</span>
        </button>
        <span className="flex-1" />
        {toolbar}
        {url && (
          <button
            type="button"
            onClick={() => void openUrl(url).catch(() => {})}
            className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
          >
            {copy.openIn.replace("{name}", providerName)}
            <ExternalLink className="size-3" aria-hidden />
          </button>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4">
        <h2 className="font-display text-[19px] leading-tight font-bold tracking-[-0.02em] text-foreground">{shown?.title ?? ticketKey}</h2>
        <p className="mt-1 font-mono text-[12px] text-primary">{ticketKey}</p>

        {shown && (
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
            {shown.priority && (
              <>
                <dt className="font-mono text-[11.5px] text-text-faint">{copy.priority}</dt>
                <dd className="flex items-center gap-1.5 text-foreground">
                  <PriorityMark priority={shown.priority} />
                  {shown.priority}
                </dd>
              </>
            )}
            <dt className="font-mono text-[11.5px] text-text-faint">{copy.status}</dt>
            <dd className="text-foreground">{shown.statusLabel}</dd>
          </dl>
        )}

        <div className="mt-4">
          {detail ? (
            detail.descriptionMd ? (
              <div data-testid="ticket-description" className="prose-chat min-w-0 text-sm text-foreground">
                <MarkdownContent text={detail.descriptionMd} />
              </div>
            ) : (
              <p className="text-sm text-text-faint">{copy.noDescription}</p>
            )
          ) : (
            placeholder
          )}
        </div>

        {sessions}

        {detail && (
          <section className="mt-6">
            <h3 className="flex items-center gap-2 font-mono text-[11.5px] text-text-faint">
              {copy.comments}
              <span aria-hidden className="h-px flex-1 border-t border-dashed border-border" />
              {detail.comments.length}
            </h3>
            {detail.comments.length === 0 ? (
              <p className="mt-2 text-sm text-text-faint">{copy.noComments}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {detail.comments.map((comment, index) => (
                  <li key={`${String(comment.createdAt)}-${String(index)}`} className="border border-border bg-bg-elevated px-3 py-2">
                    <p className="font-mono text-[11px] text-text-faint" title={formatAbsoluteTime(comment.createdAt, locale)}>
                      {comment.author} · {formatRelativeTime(comment.createdAt, locale)}
                    </p>
                    <div className="prose-chat mt-1 min-w-0 text-sm text-foreground">
                      <MarkdownContent text={comment.bodyMd} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {footer}
    </div>
  );
}
