import { AnywhLogo } from "@/components/shell/AnywhLogo";
import { cn } from "@/lib/utils";

/**
 * The onboarding's lockup: the mark beside the `anywh.sh` wordmark, drawn
 * larger than the shell's `AnywhLockup` because here it is the screen's
 * signature, not chrome. `large` is the Welcome screen's size.
 */
export function Lockup({ large = false, className }: { large?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center", large ? "gap-3.5" : "gap-2.5", className)}>
      <AnywhLogo className={cn("shrink-0", large ? "size-9" : "size-6")} />
      <span
        className={cn(
          "font-display font-bold tracking-[-0.04em] text-foreground",
          large ? "text-[21px]" : "text-[16px]",
        )}
      >
        anywh.sh
      </span>
    </span>
  );
}
