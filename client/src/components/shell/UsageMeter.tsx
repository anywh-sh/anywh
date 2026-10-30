import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";
import { clampPercent, dailyCuts, showsPaceMark, usageLevel, windowLabel, type UsageLevel } from "@/lib/planUsage/meter";

interface UsageMeterProps {
  /** Share of the window used, as the relay reported it (expired windows
   * already brought to 0 by the caller — `effectivePercent`). */
  percent: number;
  /** Window length in minutes: names the window and decides the daily cuts. */
  durationMins: number;
  /** Where usage would be at an even pace (`expectedPace`), or `null`/absent
   * for no pace mark. */
  expected?: number | null;
  /** The agent's own "near the limit" flag; raises the color to warn. */
  warning?: boolean;
  /** `card`: a 6px row of the details card, with the weekly window's daily
   * cuts. `indicator`: the 28×3 bar in the status bar. */
  variant?: "card" | "indicator";
  className?: string;
}

const FILL: Record<UsageLevel, string> = {
  neutral: "bg-muted-foreground",
  warn: "bg-warn",
  limited: "bg-err",
};

/**
 * One window of a plan (5h, 7d, 30d) as a bar: how much is used, and a 1px
 * mark where usage would be if it were spread evenly over the window.
 *
 * A `meter`, not a `progressbar`: this is a gauge of a quantity within a
 * known range, not a task advancing toward done. The pace mark is drawn for
 * the eye only; its value reaches assistive tech through `aria-valuetext`.
 * The color is never the only signal — the spent state is spelled out in
 * text by whoever places the meter ("back in 58m").
 *
 * No motion at all, by design: it updates in place when
 * a new reading arrives, and a bar that eases or pulses in the status bar
 * pulls the eye every minute for nothing.
 */
export function UsageMeter({ percent, durationMins, expected, warning, variant = "card", className }: UsageMeterProps) {
  const strings = useDict().shell.usage;
  const used = clampPercent(percent);
  const level = usageLevel(used, { warning });
  const label = windowLabel(durationMins);
  const pace = expected != null && showsPaceMark(used) ? clampPercent(expected) : null;
  const cuts = variant === "card" ? dailyCuts(durationMins) : [];
  const valueText = (pace === null ? strings.meterValue : strings.meterValueWithPace.replace("{expected}", String(pace)))
    .replace("{percent}", String(used));

  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used}
      aria-valuetext={valueText}
      aria-label={strings.meterLabel.replace("{window}", label).replace("{percent}", String(used))}
      data-level={level}
      className={cn(
        "relative shrink-0 bg-border-soft",
        variant === "card" ? "h-[6px] w-full" : "h-[3px] w-[28px]",
        className,
      )}
    >
      <div
        data-part="fill"
        className={cn("absolute inset-y-0 left-0", FILL[level])}
        style={{ width: `${String(used)}%` }}
      />
      {cuts.map((at) => (
        <div
          key={at}
          aria-hidden
          data-part="cut"
          className="absolute inset-y-0 w-px bg-background"
          style={{ left: `${String(at)}%` }}
        />
      ))}
      {pace !== null && (
        <div
          aria-hidden
          data-part="pace"
          className="absolute -inset-y-[2px] w-px -translate-x-1/2 bg-foreground"
          style={{ left: `${String(pace)}%` }}
        />
      )}
    </div>
  );
}
