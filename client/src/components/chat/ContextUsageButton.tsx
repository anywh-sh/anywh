import { useRef } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextUsageRing } from "@/components/chat/ContextUsageRing";
import { useDict } from "@/i18n";
import { contextUsageColor, contextUsagePercent, formatTokenCount } from "@/lib/format/contextUsage";
import type { ContextUsage } from "@/lib/relay/relayClient";

interface ContextUsageButtonProps {
  usage: ContextUsage | null;
}

/**
 * Ring + token count as one chip, third control on the composer's toolbar,
 * with the full detail a click away. The count reads on the chip itself
 * rather than only inside the popover: it is the reason the turn indicator
 * doesn't carry a second one, and a number nobody can see doesn't settle
 * that argument. Written compactly (`128k/200k`) with the window size a
 * shade fainter than what's been spent — the part that moves is the part
 * that reads first.
 *
 * Same pattern as the two dropdowns next to it: `modal={false}` (Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS) and blurs the trigger on
 * close (otherwise a neighboring button's Tooltip would get "stuck" open by
 * inheriting the focus). `usage` null (session with no turn yet) hides the
 * whole chip, same as the ring alone already did.
 */
export function ContextUsageButton({ usage }: ContextUsageButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict();
  if (!usage) return null;

  const copy = dict.chat.composer.context;
  const pct = contextUsagePercent(usage);
  const barColor = contextUsageColor(pct);
  // Setup segment only renders when `baselineTokens` is known — absent for
  // a record written before that field existed, or a resumed session that
  // never got a fresh baseline (see ContextAttributor's own doc comment).
  // Clamped defensively: `usedTokens` should never fall below `baselineTokens`
  // (the conversation only grows from there), but a mid-flight live update
  // and the end-of-turn merge come from two different sources, so this
  // guards against a transient underflow reading as a negative width.
  const setupPct =
    usage.baselineTokens !== undefined && usage.contextWindowSize > 0
      ? Math.min(pct, Math.max(0, (usage.baselineTokens / usage.contextWindowSize) * 100))
      : 0;
  const conversationPct = Math.max(0, pct - setupPct);

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={copy.ariaLabel.replace("{percent}", String(Math.round(pct)))}
          title={copy.label}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border border-border bg-bg-sidebar pr-2 pl-1.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-text-faint hover:text-foreground"
        >
          <ContextUsageRing usage={usage} />
          <span className="whitespace-nowrap">
            {formatTokenCount(usage.usedTokens)}
            <span className="text-text-faint">/{formatTokenCount(usage.contextWindowSize)}</span>
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-foreground">
            <span>{copy.label}</span>
            <span className="font-mono text-xs">{Math.round(pct)}%</span>
          </div>
          {/* Same color function as the ring (contextUsageColor) for the
           * conversation segment — categorical now (setup / conversation /
           * free), unlike the ring, which stays severity-only by total %:
           * they diverge on purpose, this bar shows what the ring can't. */}
          <div className="flex h-1.5 w-full overflow-hidden bg-border">
            {setupPct > 0 && <div style={{ width: `${String(setupPct)}%` }} className="h-full bg-text-faint" />}
            <div style={{ width: `${String(conversationPct)}%`, backgroundColor: barColor }} className="h-full" />
          </div>
          <span className="font-mono text-xs whitespace-nowrap text-foreground">
            {copy.tokens
              .replace("{used}", formatTokenCount(usage.usedTokens))
              .replace("{total}", formatTokenCount(usage.contextWindowSize))}
          </span>
          {usage.baselineTokens !== undefined && (
            <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
              {copy.setup.replace("{tokens}", formatTokenCount(usage.baselineTokens)).replace("{percent}", String(Math.round(setupPct)))}
            </span>
          )}
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">{usage.model}</span>
          <span className="text-[10px] text-text-faint">{copy.outputCaveat}</span>
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
