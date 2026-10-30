import { AgentLogo } from "@/components/chat/AgentLogo";
import { cn } from "@/lib/utils";

/**
 * An agent's mark in the usage view: the same product logo the room's agent
 * cards draw (`AgentLogo`), at the usage view's two sizes — 15px in the
 * status bar, 18px in the card. Colored like those cards: Claude keeps its
 * brand orange, the monochrome OpenAI mark takes the foreground ink.
 * Decorative — whoever places it names the agent in its own accessible text.
 */
export function AgentMark({ runtime, size = 15, className }: { runtime: string; size?: 15 | 18; className?: string }) {
  return (
    <span aria-hidden="true" data-agent-mark={runtime} className={cn("inline-flex shrink-0 text-foreground", className)}>
      <AgentLogo agentId={runtime} className={size === 15 ? "size-[15px]" : "size-[18px]"} />
    </span>
  );
}
