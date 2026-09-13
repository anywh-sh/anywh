import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A labelled input, the way every form in the app labels one: mono
 * eyebrow above, control below. `id` wires the label to the control so the
 * field is reachable by its label — the only handle a test has on it. */
export function Field({ id, label, className, children }: { id: string; label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="font-mono text-[10px] font-medium tracking-[0.14em] text-text-faint uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}
