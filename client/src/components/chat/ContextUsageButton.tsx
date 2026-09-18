import { useRef } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextUsageRing } from "@/components/chat/ContextUsageRing";
import { useDict } from "@/i18n";
import { contextUsageColor, contextUsagePercent, formatTokenCount } from "@/lib/format/contextUsage";
import type { ContextUsage } from "@/lib/relay/relayClient";

interface ContextUsageButtonProps {
  usage: ContextUsage | null;
  /** Fired every time the popover opens — cheap to call more than once,
   * since the relay caches the result on `contextUsage.breakdown` and only
   * re-reads the rule file when its `mtime` actually changed. */
  onOpen: () => void;
}

interface BreakdownSegment {
  key: string;
  label: string;
  tokens: number;
  color: string;
  hint?: string;
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
 * The popover renders one of two shapes, depending on whether
 * `usage.breakdown` has arrived yet (it's requested on open, see `onOpen`,
 * and answered asynchronously — the relay may need to read a rule file and
 * tokenize it):
 * - **Before/without a breakdown**: the original two-segment bar (setup vs.
 *   conversation) — still correct on its own, and the only view a def with
 *   no `contextAccounting` (an honest "can't break this one down") ever
 *   gets.
 * - **Once a breakdown exists**: a fully categorical bar — Rules/Skills/
 *   Subagents/Empty-folder/System-prompt-residual, then Conversation, then
 *   free space. Which of the Setup categories show up is driven entirely by
 *   what the relay actually returned (`ContextAccounting` per def): Claude
 *   never sends `skills` (the description doesn't even reach its prompt at
 *   a cost worth a line), Codex never sends `subagents` (no such concept).
 *   The bar and the ring diverge on purpose here — the ring stays
 *   severity-only by total %, this bar categorizes what the ring can't.
 *
 * Same pattern as the two dropdowns next to it: `modal={false}` (Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS) and blurs the trigger on
 * close (otherwise a neighboring button's Tooltip would get "stuck" open by
 * inheriting the focus). `usage` null (session with no turn yet) hides the
 * whole chip, same as the ring alone already did.
 */
export function ContextUsageButton({ usage, onOpen }: ContextUsageButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict();
  if (!usage) return null;

  const copy = dict.chat.composer.context;
  const pct = contextUsagePercent(usage);
  const barColor = contextUsageColor(pct);
  const total = usage.contextWindowSize;
  const conversationTokens = Math.max(0, usage.usedTokens - (usage.baselineTokens ?? 0));

  const breakdown = usage.breakdown;
  const setupSegments: BreakdownSegment[] = [];
  if (breakdown?.rules) setupSegments.push({ key: "rules", label: copy.breakdownRules, tokens: breakdown.rules.tokens, color: "var(--profile-2)" });
  if (breakdown?.skills) setupSegments.push({ key: "skills", label: copy.breakdownSkills, tokens: breakdown.skills.tokens, color: "var(--profile-4)" });
  if (breakdown?.subagents) setupSegments.push({ key: "subagents", label: copy.breakdownSubagents, tokens: breakdown.subagents.tokens, color: "var(--profile-3)" });
  if (breakdown?.emptyDirectory)
    setupSegments.push({
      key: "emptyDirectory",
      label: copy.breakdownEmptyDirectory,
      tokens: breakdown.emptyDirectory.tokens,
      color: "var(--context-ring-warn)",
      hint: copy.breakdownEmptyDirectoryHint,
    });
  if (breakdown?.residual)
    setupSegments.push({
      key: "residual",
      label: copy.breakdownSystemPromptTools,
      tokens: breakdown.residual.tokens,
      color: "var(--text-faint)",
      hint: copy.breakdownSystemPromptToolsHint,
    });

  const hasDetailedBreakdown = setupSegments.length > 0;

  // Setup segment of the simple two-segment bar only renders when
  // `baselineTokens` is known — absent for a record written before that
  // field existed, or a resumed session that never got a fresh baseline
  // (see ContextAttributor's own doc comment). Clamped defensively:
  // `usedTokens` should never fall below `baselineTokens` (the conversation
  // only grows from there), but a mid-flight live update and the end-of-turn
  // merge come from two different sources, so this guards against a
  // transient underflow reading as a negative width.
  const setupPct = usage.baselineTokens !== undefined && total > 0 ? Math.min(pct, Math.max(0, (usage.baselineTokens / total) * 100)) : 0;
  const conversationPct = Math.max(0, pct - setupPct);

  const topSources = usage.sources
    ? Object.entries(usage.sources)
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .slice(0, 5)
    : [];

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) onOpen();
        else triggerRef.current?.blur();
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

          {hasDetailedBreakdown ? (
            <>
              <div className="flex h-1.5 w-full overflow-hidden bg-border">
                {setupSegments.map((segment) => (
                  <div key={segment.key} style={{ width: `${String((segment.tokens / total) * 100)}%`, backgroundColor: segment.color }} className="h-full" />
                ))}
                {conversationTokens > 0 && (
                  <div style={{ width: `${String((conversationTokens / total) * 100)}%`, backgroundColor: barColor }} className="h-full" />
                )}
              </div>
              <div className="flex flex-col">
                {setupSegments.map((segment) => (
                  <div key={segment.key} className="flex flex-col gap-0.5 border-b border-border-soft py-1 first:pt-0 last:border-b-0">
                    <div className="flex items-center gap-1.5">
                      <span className="size-1.5 shrink-0" style={{ backgroundColor: segment.color }} aria-hidden="true" />
                      <span className="flex-1 truncate text-[11.5px] text-foreground">{segment.label}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatTokenCount(segment.tokens)}</span>
                    </div>
                    {segment.hint && <span className="pl-3 text-[10px] text-text-faint">{segment.hint}</span>}
                  </div>
                ))}
                <div className="flex items-center gap-1.5 py-1">
                  <span className="size-1.5 shrink-0" style={{ backgroundColor: barColor }} aria-hidden="true" />
                  <span className="flex-1 truncate text-[11.5px] text-foreground">{copy.breakdownConversation}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatTokenCount(conversationTokens)}</span>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Same color function as the ring (contextUsageColor) for the
               * conversation segment — categorical (setup / conversation /
               * free), unlike the ring, which stays severity-only by total
               * %: they diverge on purpose, this bar shows what the ring
               * can't. Shown until (or instead of) the detailed
               * per-category breakdown above. */}
              <div className="flex h-1.5 w-full overflow-hidden bg-border">
                {setupPct > 0 && <div style={{ width: `${String(setupPct)}%` }} className="h-full bg-text-faint" />}
                <div style={{ width: `${String(conversationPct)}%`, backgroundColor: barColor }} className="h-full" />
              </div>
              {usage.baselineTokens !== undefined && (
                <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                  {copy.setup.replace("{tokens}", formatTokenCount(usage.baselineTokens)).replace("{percent}", String(Math.round(setupPct)))}
                </span>
              )}
            </>
          )}

          <span className="font-mono text-xs whitespace-nowrap text-foreground">
            {copy.tokens.replace("{used}", formatTokenCount(usage.usedTokens)).replace("{total}", formatTokenCount(usage.contextWindowSize))}
          </span>
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">{usage.model}</span>
          <span className="text-[10px] text-text-faint">{copy.outputCaveat}</span>
          {topSources.length > 0 && (
            <div className="mt-1 flex flex-col gap-1 border-t border-border-soft pt-1.5">
              <span className="text-[11px] text-muted-foreground">{copy.topConsumers}</span>
              {topSources.map(([name, source]) => (
                <div key={name} className="flex items-center justify-between gap-2 font-mono text-[11px] text-foreground">
                  <span className="truncate">{name}</span>
                  <span className="shrink-0 text-text-faint">
                    {formatTokenCount(source.tokens)} · {source.calls}×
                  </span>
                </div>
              ))}
            </div>
          )}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
