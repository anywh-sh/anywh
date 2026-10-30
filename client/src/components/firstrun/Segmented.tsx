import { handleRovingKeyDown } from "@/components/firstrun/rovingKeys";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A two-or-three way switch (Code | Address, In the app | In the terminal).
 * A tablist: each option swaps the panel below it rather than choosing a
 * value in a form, so `tab`/`aria-selected` is the honest role. The panel
 * is the caller's — give it `role="tabpanel"` and point it back with
 * `aria-labelledby={`${id}-${value}`}`.
 */
export function Segmented<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
}: {
  id: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} onKeyDown={(event) => handleRovingKeyDown(event, "tab")} className="inline-flex self-start border border-border p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 cursor-pointer px-3 text-[length:calc(12px*var(--font-scale-ratio))] outline-hidden transition-colors focus-visible:underline",
              selected ? "bg-surface-hover text-foreground" : "text-text-faint hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
