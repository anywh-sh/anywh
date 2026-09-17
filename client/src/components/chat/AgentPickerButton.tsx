import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { getHostInfo, type SelectableAgentInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";
import { cn } from "@/lib/utils";

interface AgentPickerButtonProps {
  profile: Profile;
  /** This session's own agent, from `agent_state` — `null` in the brief
   * window before the first one arrives (`useRelayClient`), same as every
   * other toolbar control's initial state. Deliberately NOT derived from
   * `/host-info` (that's per-relay, not per-session): the picker needs to
   * know the SESSION's current agent, and the relay has no idea which
   * session this button belongs to. */
  agentId: string | null;
  onChange: (agentId: string) => void;
}

/** Same id-switch-with-literal-fallback shape as `PermissionModeButton`'s
 * `modeCopy` — an agent id this build has no name for (a def added after
 * this build shipped) renders as the raw id rather than crashing. */
function agentName(agentNames: Record<KnownAgentId, string>, id: string): string {
  return agentNames[id as KnownAgentId] ?? id;
}

/**
 * First control on the composer's toolbar, before `PermissionModeButton`.
 * Fetches `/host-info` for the relay's own `agents` list (`SelectableAgentInfo[]`,
 * already filtered to installed+selectable ids by the relay) — hidden
 * entirely when there's zero or one entry, same as before this had a real
 * dropdown: a relay without a second agent installed shows nothing extra.
 */
export function AgentPickerButton({ profile, agentId, onChange }: AgentPickerButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [agents, setAgents] = useState<SelectableAgentInfo[]>([]);
  const agentNames = useDict().chat.composer.agentNames;

  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (!cancelled) setAgents(info.agents ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile]);

  if (agents.length <= 1) return null;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={agentId === null} className="min-w-0 gap-1.5 px-2">
          <Bot className="size-3" />
          <span className="truncate">{agentId !== null ? agentName(agentNames, agentId) : "…"}</span>
          <ChevronDown className="size-2.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-40">
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => onChange(agent.id)} className="gap-3">
            <span className="flex-1 truncate text-left">{agentName(agentNames, agent.id)}</span>
            <Check className={cn("size-3.5 text-primary!", agent.id !== agentId && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
