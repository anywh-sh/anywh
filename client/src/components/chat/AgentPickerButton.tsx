import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentLogo, agentVendor } from "@/components/chat/AgentLogo";
import { toolbarTriggerClass } from "@/components/chat/toolbarTrigger";
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
  /** `true` once the conversation has had its first turn (same signal as
   * `ModelButton`'s `locked`): the session's agent can't change after that.
   * The trigger stays enabled so its tooltip still names the agent in use,
   * but it no longer opens the menu or shows the chevron. */
  locked: boolean;
}

/** Same id-switch-with-literal-fallback shape as `PermissionModeButton`'s
 * `modeCopy` — an agent id this build has no name for (a def added after
 * this build shipped) renders as the raw id rather than crashing. */
export function agentName(agentNames: Record<KnownAgentId, string>, id: string): string {
  return agentNames[id as KnownAgentId] ?? id;
}

/**
 * First control on the composer's toolbar, before `PermissionModeButton`.
 * Fetches `/host-info` for the relay's own `agents` list (`SelectableAgentInfo[]`,
 * already filtered to installed+selectable ids by the relay) — hidden
 * entirely when there's zero or one entry, same as before this had a real
 * dropdown: a relay without a second agent installed shows nothing extra.
 */
export function AgentPickerButton({ profile, agentId, onChange, locked }: AgentPickerButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
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
      // Controlled for the same reason as `ModelButton`: locking has to stop
      // the menu from opening whichever low-level event the WebView fires.
      open={open}
      onOpenChange={(next) => {
        if (next && locked) return;
        setOpen(next);
        if (!next) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={agentId === null}
          title={agentId !== null ? agentName(agentNames, agentId) : undefined}
          aria-label={agentId !== null ? agentName(agentNames, agentId) : undefined}
          className={cn(toolbarTriggerClass, locked && "cursor-default hover:text-muted-foreground")}
        >
          {agentId !== null && <AgentLogo agentId={agentId} className="size-3.5" />}
          {!locked && (
            <span aria-hidden="true" className="text-[9px] opacity-55">
              ▾
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-40">
        {agents.map((agent) => {
          const vendor = agentVendor(agent.id);
          const detail = [vendor, agent.version !== undefined ? `${agent.id} v${agent.version}` : undefined].filter(Boolean).join(" · ");
          const current = agent.id === agentId;
          return (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onChange(agent.id)}
              className={cn("items-start gap-3 py-2", current && "bg-primary-soft")}
            >
              <span className="flex size-6 shrink-0 items-center justify-center border border-border-soft">
                <AgentLogo agentId={agent.id} className="size-3.5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <span className="truncate">{agentName(agentNames, agent.id)}</span>
                {detail !== "" && <span className="truncate font-sans text-[11px] text-muted-foreground">{detail}</span>}
              </span>
              <Check className={cn("mt-1 size-3.5 text-primary!", !current && "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
