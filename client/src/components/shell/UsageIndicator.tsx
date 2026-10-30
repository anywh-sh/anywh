import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { AgentMark } from "@/components/shell/AgentMark";
import { UsageMeter } from "@/components/shell/UsageMeter";
import { agentName } from "@/components/chat/AgentModelEffortButton";
import { useIsCompactStatusBar } from "@/hooks/platform/useMediaQuery";
import { useDict, useLocale, type Dictionary, type Locale } from "@/i18n";
import {
  accountWindows,
  groupByProfile,
  strongestWindow,
  otherProfileAlerts,
  profileDataState,
  runtimeWindows,
  spentUntil,
  type ProfileAlert,
  type ProfilePlanUsage,
  type WindowView,
} from "@/lib/planUsage/derive";
import { formatResetPhrase, formatUpdatedAgo } from "@/lib/planUsage/format";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";
import { profileColorClass } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

type UsageStrings = Dictionary["shell"]["usage"];

export interface UsageIndicatorProps extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
  /** The active tab's profile: its agents are the ones shown. */
  profileId: string;
  /** Every profile, in the list's order (for the other-profile alerts). */
  profiles: readonly { id: string; label: string }[];
  byProfile: Readonly<Record<string, ProfilePlanUsage>>;
  /** The view's clock (`usePlanUsage().now`). */
  now: number;
  /** Whether the details card is open — mirrored to `aria-expanded`. */
  expanded: boolean;
}

/**
 * The status bar's plan usage: the active tab's profile, then one block per
 * agent installed on its machine (the relay only reports installed ones),
 * then a dot for every other profile near or at its limit. One button — the
 * details card opens from it (`expanded`/`onClick` are the caller's).
 *
 * Under 1024px it keeps only each agent's mark and 5h percentage. Nothing in
 * it moves on its own: the numbers change in place when a reading arrives.
 * With the machine unreachable it keeps the last numbers, quieter, and says
 * so in its accessible name. A relay too old for plan usage shows a short
 * "update relay". Renders nothing while there is nothing to show — no agent
 * installed, or no answer yet.
 */
export const UsageIndicator = forwardRef<HTMLButtonElement, UsageIndicatorProps>(function UsageIndicator(
  { profileId, profiles, byProfile, now, expanded, className, ...buttonProps },
  ref,
) {
  const dict = useDict();
  const { locale } = useLocale();
  const strings = dict.shell.usage;
  const compact = useIsCompactStatusBar();

  const entry = byProfile[profileId];
  const data = profileDataState(entry);
  const runtimes = data === "live" || data === "stale" ? (entry?.runtimes ?? []) : [];
  const groups = groupByProfile(
    profiles.map((profile) => profile.id),
    byProfile,
    profileId,
  );
  const alerts = otherProfileAlerts(groups, now);
  // A relay too old for plan usage still gets a mark: hiding the indicator
  // would read exactly like a profile with no agent installed, and leave
  // nothing to tell that the relay is what needs updating.
  const outdated = data === "unsupported";
  if (runtimes.length === 0 && alerts.length === 0 && !outdated) return null;

  const labelOf = (id: string): string => profiles.find((profile) => profile.id === id)?.label ?? id;
  const names = dict.chat.composer.agentNames;
  const stale = data === "stale";
  const summary = [
    ...(outdated ? [strings.outdatedSummary] : []),
    ...runtimes.map((usage) => summarize(usage, agentName(names, usage.runtime), now, locale, strings)),
    ...alerts.map((alert) => (alert.level === "limited" ? strings.alertLimited : strings.alertWarn).replace("{profile}", labelOf(alert.profileId))),
  ];
  if (stale && entry?.receivedAt != null) {
    summary.push(strings.stale.replace("{ago}", formatUpdatedAgo(strings, entry.receivedAt, now)));
  }

  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={strings.summary.replace("{items}", summary.join("; "))}
      data-usage-indicator
      data-stale={stale || undefined}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-2.5 px-1.5 py-0.5 outline-hidden transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover",
        expanded && "bg-surface-hover",
        className,
      )}
      {...buttonProps}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0", profileColorClass(profileId))} />
      {outdated && (
        <span data-usage-outdated className="whitespace-nowrap text-text-faint">
          {strings.outdated}
        </span>
      )}
      {runtimes.map((usage) => (
        <AgentBlock key={usage.runtime} usage={usage} now={now} compact={compact} stale={stale} locale={locale} strings={strings} />
      ))}
      {alerts.length > 0 && (
        <>
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
          {alerts.map((alert) => (
            <AlertDot key={alert.profileId} alert={alert} />
          ))}
        </>
      )}
    </button>
  );
});

function AlertDot({ alert }: { alert: ProfileAlert }) {
  return (
    <span data-usage-alert={alert.profileId} data-level={alert.level} aria-hidden="true" className="flex shrink-0 items-center gap-1">
      <span className={cn("size-1.5", profileColorClass(alert.profileId))} />
      <span className={cn("size-1.5 rounded-full", alert.level === "limited" ? "bg-err" : "bg-warn")} />
    </span>
  );
}

/** The window the compact form and the summary lead with: 5h when there is
 * one, else the shortest of the account's windows. */
function leadWindow(views: readonly WindowView[]): WindowView | undefined {
  return views.find((view) => view.durationMins === 300) ?? views[0];
}

function AgentBlock({
  usage,
  now,
  compact,
  stale,
  locale,
  strings,
}: {
  usage: RuntimePlanUsage;
  now: number;
  compact: boolean;
  stale: boolean;
  locale: Locale;
  strings: UsageStrings;
}) {
  const views = accountWindows(runtimeWindows(usage, now));
  const headline = strongestWindow(views);
  const block = (children: ReactNode) => (
    <span
      data-usage-agent={usage.runtime}
      className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", stale && "opacity-60")}
    >
      <AgentMark runtime={usage.runtime} />
      {children}
    </span>
  );

  if (views.length === 0 || !headline) {
    if (usage.status === "signed_out") {
      return block(
        <>
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
          {!compact && <span>{strings.signedOut}</span>}
        </>,
      );
    }
    if (usage.status === "no_subscription") {
      return block(<span className="border border-border px-1 leading-[14px] text-muted-foreground">{strings.apiKey}</span>);
    }
    return block(!compact && <span>{usage.status === "error" ? strings.readError : strings.noData}</span>);
  }

  const lead = leadWindow(views) ?? headline;
  const reset = spentUntil(views);
  const spent = headline.level === "limited";
  const tone = (view: WindowView) =>
    view.level === "limited" ? "font-medium text-err" : view.level === "warn" ? "font-medium text-warn" : "text-muted-foreground";

  if (compact) {
    return block(<span className={tone(lead)}>{lead.percent}%</span>);
  }

  const resetPhrase = spent && reset !== null ? formatResetPhrase(strings, reset, now, locale) : null;
  return block(
    <>
      <UsageMeter variant="indicator" percent={headline.percent} durationMins={headline.durationMins} warning={usage.status === "warning"} />
      {spent ? (
        <span className="text-err">{resetPhrase ?? strings.limited}</span>
      ) : (
        <span>
          <span className={tone(lead)}>
            {lead.percent}% {lead.label}
          </span>
          {views
            .filter((view) => view !== lead)
            .slice(0, 1)
            .map((view) => (
              <span key={view.label} className={cn("text-text-faint", view.level !== "neutral" && tone(view))}>
                {" "}
                · {view.percent}% {view.label}
              </span>
            ))}
        </span>
      )}
    </>,
  );
}

/** One agent's phrase in the button's accessible name. */
function summarize(usage: RuntimePlanUsage, agent: string, now: number, locale: Locale, strings: UsageStrings): string {
  const views = accountWindows(runtimeWindows(usage, now));
  const headline = strongestWindow(views);
  const state = (word: string) => strings.summaryState.replace("{agent}", agent).replace("{state}", word);
  if (views.length === 0 || !headline) {
    if (usage.status === "signed_out") return state(strings.signedOut);
    if (usage.status === "no_subscription") return state(strings.apiKey);
    return state(usage.status === "error" ? strings.readError : strings.noData);
  }
  if (headline.level === "limited") {
    const reset = spentUntil(views);
    const phrase = reset === null ? null : formatResetPhrase(strings, reset, now, locale);
    return phrase ? strings.summaryLimited.replace("{agent}", agent).replace("{reset}", phrase) : state(strings.limited);
  }
  const lead = leadWindow(views) ?? headline;
  return strings.summaryWindow.replace("{agent}", agent).replace("{percent}", String(lead.percent)).replace("{window}", lead.label);
}
