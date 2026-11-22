import { MessageSquare, Network, Plus } from "lucide-react";
import { RowButton } from "@/components/ui/row-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Mascot } from "@/components/bots/Mascot";
import { useDict } from "@/i18n";
import { BOT_TEMPLATES, type BotTemplateId } from "@/lib/bots/templates";

/** The hero's dot grid: the room canvas's `--canvas-grid` dots. */
const DOT_GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, var(--canvas-grid) 1px, transparent 1.5px)",
  backgroundSize: "16px 16px",
  backgroundPosition: "8px 8px",
} as const;

interface BotTemplatesViewProps {
  /** Opens "New bot", filled from `templateId` (or blank, from scratch). */
  onPick: (templateId?: BotTemplateId) => void;
}

/**
 * The bot templates, as a tab of their own: what a bot is (the faces of the
 * templates, a line, three things it does), then a card per template, the
 * first one starting from scratch. A card opens "New bot" filled in.
 */
export function BotTemplatesView({ onPick }: BotTemplatesViewProps) {
  const dict = useDict();
  const copy = dict.bots.templatesTab;
  const features = [
    { icon: <MessageSquare className="size-4" />, title: copy.anywhere, body: copy.anywhereBody },
    { icon: <Network className="size-4" />, title: copy.delegates, body: copy.delegatesBody },
    { icon: <span className="m-1 block size-1.5 rounded-full bg-primary" />, title: copy.quiet, body: copy.quietBody },
  ];
  return (
    <ScrollArea className="h-full" data-testid="bot-templates-view">
      <div className="border-b border-border bg-bg-chrome" style={DOT_GRID_STYLE}>
        <div className="mx-auto flex max-w-[1000px] flex-col items-center gap-4 px-10 pt-10 pb-[30px] text-center">
          <div className="flex items-end gap-3.5" aria-hidden>
            {BOT_TEMPLATES.map((each) => (
              <Mascot key={each.id} mascot={each.mascot} size={48} />
            ))}
          </div>
          <h1 className="font-display text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-foreground">{copy.heading}</h1>
          <p className="max-w-[540px] text-[15px] leading-relaxed text-muted-foreground">{dict.bots.emptyBody}</p>
          <div className="mt-1.5 grid w-full max-w-[780px] grid-cols-1 border border-border bg-bg-sidebar text-left md:grid-cols-3">
            {features.map((each) => (
              <div key={each.title} className="flex flex-col gap-1.5 border-border px-4 py-3.5 not-last:border-b md:not-last:border-r md:not-last:border-b-0">
                <span className="flex h-4 items-center text-muted-foreground">{each.icon}</span>
                <span className="text-[13.5px] font-medium text-foreground">{each.title}</span>
                <span className="text-[12.5px] leading-normal text-text-faint">{each.body}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-3.5 px-10 pt-[26px] pb-10">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-[19px] font-semibold tracking-[-0.01em] text-foreground">{copy.list}</h2>
          <span className="font-mono text-[11.5px] text-text-faint">{BOT_TEMPLATES.length}</span>
        </div>
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          <RowButton size="auto" onClick={() => onPick()} className="flex-col items-stretch gap-3 border border-dashed border-text-faint/60 p-4 text-left hover:bg-surface-hover" data-testid="bot-template-scratch">
            <span className="flex items-center gap-3">
              <span aria-hidden className="flex size-14 shrink-0 items-center justify-center border border-dashed border-text-faint/60 text-muted-foreground">
                <Plus className="size-[18px]" />
              </span>
              <span className="flex flex-col gap-[3px]">
                <span className="text-[14.5px] font-medium text-foreground">{copy.scratch}</span>
                <span className="font-mono text-[11px] text-text-faint">{copy.scratchWhen}</span>
              </span>
            </span>
            <span className="text-[13px] leading-normal whitespace-normal text-text-faint">{copy.scratchBody}</span>
          </RowButton>
          {BOT_TEMPLATES.map((each) => {
            const words = dict.bots.templates[each.id];
            return (
              <RowButton key={each.id} size="auto" onClick={() => onPick(each.id)} className="flex-col items-stretch gap-3 border border-border bg-bg-sidebar p-4 text-left hover:bg-surface-hover" data-testid={`bot-template-${each.id}`}>
                <span className="flex items-center gap-3">
                  <span className="flex size-14 shrink-0 items-center justify-center border border-border bg-background">
                    <Mascot mascot={each.mascot} size={48} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="text-[14.5px] font-medium text-foreground">{words.name}</span>
                    <span className="truncate font-mono text-[11px] text-text-faint">{words.when}</span>
                  </span>
                </span>
                <span className="text-[13px] leading-normal whitespace-normal text-muted-foreground">{words.line}</span>
                <span className="grid grid-cols-[58px_minmax(0,1fr)] gap-y-1 text-[12.5px] leading-snug whitespace-normal text-text-faint">
                  <span className="pt-px font-mono text-[11px]">{copy.watches}</span>
                  <span>{words.watches}</span>
                  <span className="pt-px font-mono text-[11px]">{copy.reports}</span>
                  <span>{words.reports}</span>
                </span>
              </RowButton>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
