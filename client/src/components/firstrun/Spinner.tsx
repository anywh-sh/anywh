import { cn } from "@/lib/utils";

/** A 12px ring that turns. Decorative: whatever it sits beside carries the
 * accessible name, so it is hidden from the tree. The blanket
 * `prefers-reduced-motion` rule in `index.css` already stills it. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-3 shrink-0 animate-spin rounded-full border border-border border-t-foreground", className)}
    />
  );
}
