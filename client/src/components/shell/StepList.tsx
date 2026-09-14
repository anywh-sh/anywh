import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepRow {
  key: string;
  label: string;
  status: StepStatus;
  /** Right-aligned mono detail — what the step learned (a version, a
   * size, an address). Shown for a finished step, or as the failure word. */
  meta?: string;
}

function StepIndicator({ status }: { status: StepStatus }) {
  if (status === "done") return <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />;
  if (status === "failed") return <X className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className={cn("size-2.5 shrink-0 rounded-full", status === "running" ? "animate-pulse bg-primary" : "bg-border")}
    />
  );
}

/**
 * The visual language every multi-step process in the app shares: one row
 * per step, an indicator that is a dot, a pulsing dot, a check or a cross,
 * and an optional mono detail on the right. Purely presentational — the
 * profile-setup dialog derives its rows from `SetupState`, the local relay
 * install from the installer's porcelain, and neither derivation lives
 * here.
 */
export function StepList({ steps, label }: { steps: StepRow[]; label: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" aria-label={label}>
      {steps.map((step) => (
        <div key={step.key} className="flex items-center gap-2.5 text-sm">
          <StepIndicator status={step.status} />
          <span
            className={cn(
              "min-w-0 flex-1",
              step.status === "pending" && "text-muted-foreground",
              step.status === "failed" && "text-destructive",
            )}
          >
            {step.label}
          </span>
          {step.meta && <span className="shrink-0 font-mono text-[11px] text-text-faint">{step.meta}</span>}
        </div>
      ))}
    </div>
  );
}
