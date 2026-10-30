import { Check } from "lucide-react";
import { useDict } from "@/i18n";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: string;
  label: string;
}

/**
 * The header's "where am I": an ordered list, one square marker per step,
 * a connector between them. Steps before `current` are done (a green
 * check), `current` is filled and carries `aria-current="step"`, the rest
 * are outlined. Pure presentation: the screens decide the steps and which
 * one is current.
 */
export function Stepper({ steps, current }: { steps: StepperStep[]; current: string }) {
  const label = useDict().firstRun.frame.steps.label;
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <ol aria-label={label} className="flex items-center">
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={step.id} aria-current={active ? "step" : undefined} className="flex items-center">
            {index > 0 && <span aria-hidden="true" className="mx-2.5 h-px w-5 bg-border" />}
            <span
              aria-hidden="true"
              className={cn(
                "flex size-[18px] items-center justify-center border font-mono text-[10px]",
                active ? "border-foreground bg-foreground text-background" : "border-border text-text-faint",
              )}
            >
              {done ? <Check className="size-3 text-diff-add" /> : index + 1}
            </span>
            <span className={cn("ml-2 text-[12px]", active ? "text-foreground" : "text-text-faint")}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
