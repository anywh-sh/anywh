import type * as React from "react";
import { handleRovingKeyDown } from "@/lib/rovingKeys";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Drawn before the label. */
  icon?: React.ReactNode;
}

/**
 * A two-or-three way switch (Code | Address, In the app | In the terminal,
 * Notify | Install | Never). The options sit inside one outline, the chosen
 * one on the raised surface.
 *
 * `kind` is the semantics, not the look:
 *
 * - `tabs` (default) when each option swaps the panel below it rather than
 *   choosing a value in a form — `tab`/`aria-selected`. The panel is the
 *   caller's: give it `role="tabpanel"` and point it back with
 *   `aria-labelledby={`${id}-${value}`}`.
 * - `radio` when it sets a value and nothing below changes —
 *   `radio`/`aria-checked`.
 *
 * Either way the arrow keys move and select (selection follows focus) and
 * only the chosen option is in the Tab order, the way a native group behaves.
 */
export function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
  kind = "tabs",
  className,
}: {
  id: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  kind?: "tabs" | "radio";
  className?: string;
}) {
  const role = kind === "tabs" ? "tab" : "radio";
  return (
    <div
      data-slot="segmented"
      role={kind === "tabs" ? "tablist" : "radiogroup"}
      aria-label={label}
      onKeyDown={(event) => handleRovingKeyDown(event, role)}
      className={cn("inline-flex self-start border border-border p-0.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role={role}
            {...(kind === "tabs" ? { "aria-selected": selected } : { "aria-checked": selected })}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-[7px] px-3 text-[length:calc(12px*var(--font-scale-ratio))] outline-hidden transition-colors focus-visible:underline",
              selected ? "bg-surface-hover text-foreground" : "text-text-faint hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
