import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { cn } from "@/lib/utils";

/**
 * An agent's mark in the usage view: a text seal ("CC", "CX") until the
 * logos are in. The one place that draws it, so swapping in the SVGs is a
 * change to this file alone. Decorative — whoever places it names the agent
 * in its own accessible text.
 */
export function AgentMark({ runtime, size = 15, className }: { runtime: string; size?: 15 | 18; className?: string }) {
  const marks = useDict().shell.usage.marks;
  const text = marks[runtime as KnownAgentId] ?? runtime.slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden="true"
      data-agent-mark={runtime}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border font-mono font-semibold leading-none text-muted-foreground",
        size === 15 ? "size-[15px] text-[8px]" : "size-[18px] text-[9.5px]",
        className,
      )}
    >
      {text}
    </span>
  );
}
