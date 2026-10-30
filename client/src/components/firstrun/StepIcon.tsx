import { Check, X } from "lucide-react";
import { Spinner } from "@/components/firstrun/Spinner";

export type OnboardingStepStatus = "pending" | "running" | "done" | "failed";

/**
 * The onboarding's step marker: a green check, a spinner, a red cross, or
 * an empty square. Not the shell's `StepList` dot: on these screens the
 * accent is kept for the mark and the `$`, so progress never draws in it.
 */
export function StepIcon({ status }: { status: OnboardingStepStatus | "warning" }) {
  if (status === "done") return <Check className="size-3.5 shrink-0 text-diff-add" aria-hidden="true" />;
  if (status === "failed") return <X className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />;
  if (status === "running") return <Spinner className="size-3.5" />;
  return <span className="mx-[3px] size-2 shrink-0 border border-text-faint" aria-hidden="true" />;
}

/** A plain list of steps with the marker above — what "another machine"
 * shows while it connects. */
export function StepRows({ steps, label }: { steps: Array<{ key: string; label: string; status: OnboardingStepStatus | "warning" }>; label: string }) {
  return (
    <ol className="flex flex-col gap-2.5" role="status" aria-live="polite" aria-label={label}>
      {steps.map((step) => (
        <li key={step.key} className="flex items-center gap-3">
          <StepIcon status={step.status} />
          <span className={step.status === "pending" ? "text-[length:calc(14px*var(--font-scale-ratio))] text-text-faint" : "text-[length:calc(14px*var(--font-scale-ratio))] text-foreground"}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
