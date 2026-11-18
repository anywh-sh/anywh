import { cn } from "@/lib/utils";

/**
 * A pulsing block that holds the place of content still on its way — sized
 * by the caller to what it stands in for (a line of text, an icon), so the
 * layout doesn't jump when the real thing lands. Decorative: whoever renders
 * it says what's loading (`aria-label`, `role="status"`) where that matters.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return <span aria-hidden data-slot="skeleton" className={cn("inline-block animate-pulse bg-border align-middle", className)} {...props} />;
}
