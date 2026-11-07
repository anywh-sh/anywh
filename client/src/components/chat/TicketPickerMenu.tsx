import { IntegrationIcon } from "@/components/integrations/IntegrationIcon";
import { useDict } from "@/i18n";
import type { TicketPickItem } from "@/lib/composer/ticketSuggestion";
import { cn } from "@/lib/utils";

interface TicketPickerMenuProps {
  items: TicketPickItem[];
  query: string;
  selectedIndex: number;
  /** Enter and Tab take the selected row (see `enterPicks`); when Enter would send
   * the message instead, no row is drawn as selected. */
  armed: boolean;
  onHover: (index: number) => void;
  onPick: (item: TicketPickItem) => void;
}

/**
 * The composer's `#` menu (Tiptap's `Suggestion` in Composer.tsx), dressed
 * like the `/` one: what was typed after `#`, then the person's tickets —
 * key, title, where it stands — or, with no tracker to read, the way to
 * connect one.
 */
export function TicketPickerMenu({ items, query, selectedIndex, armed, onHover, onPick }: TicketPickerMenuProps) {
  const dict = useDict();
  const copy = dict.chat.composer.tickets;
  if (items.length === 0) return null;
  return (
    <div role="listbox" aria-label={copy.label} data-testid="ticket-picker" className="z-50 w-[30rem] max-w-[calc(100vw-2rem)] border border-border bg-popover shadow-popover">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2 text-[12.5px]">
        <span aria-hidden className="font-mono text-text-faint">
          #
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">{query}</span>
        <span className="shrink-0 font-mono text-[11px] text-text-faint">{copy.yours}</span>
      </div>
      <ul className="max-h-64 overflow-y-auto p-1">
        {items.map((item, index) => (
          <li key={item.kind === "ticket" ? item.key : "connect"}>
            <button
              type="button"
              role="option"
              aria-selected={armed && index === selectedIndex}
              data-ticket-option={item.kind === "ticket" ? item.key : "connect"}
              onMouseEnter={() => onHover(index)}
              // Keeps the editor's focus (and the suggestion) through the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(item)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 px-2 py-1.5 text-left text-[13px] transition-colors",
                armed && index === selectedIndex ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-surface-hover",
              )}
            >
              {item.kind === "ticket" ? (
                <>
                  <span className="w-[5.5rem] shrink-0 truncate font-mono text-[12px]">{item.key}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                  {item.statusLabel && <span className="shrink-0 font-mono text-[11px] text-text-faint">{item.statusLabel}</span>}
                </>
              ) : (
                <>
                  <IntegrationIcon provider={item.provider} className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{copy.connect.replace("{name}", dict.integrations.providers[item.provider])}</span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
