import { cn } from "@/lib/utils";
import { useDict } from "@/i18n";

/**
 * Stands in for a title the relay is still generating (a room's principal and
 * its workers start with the first line of their task, which would flash and
 * then change): the same pulsing bar as the session list's and the message
 * log's skeletons, sized to a line of text and clipped to its container.
 */
export function TitleSkeleton({ className }: { className?: string }) {
  const dict = useDict();
  return <span role="status" aria-label={dict.common.generatingTitle} className={cn("inline-block h-[0.7em] w-28 max-w-full animate-pulse bg-border align-middle", className)} />;
}
