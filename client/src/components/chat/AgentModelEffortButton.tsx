import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarTriggerClass } from "@/components/chat/toolbarTrigger";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { getHostInfo, type SelectableAgentInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relayClient";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import { effectiveEffort, effectiveModelOption, labelForEffort } from "@/lib/composer/effortCatalog";
import { cn } from "@/lib/utils";

/** Same id-switch-with-literal-fallback shape as `PermissionModeButton`'s
 * `modeCopy` — an agent id this build has no name for (a def added after
 * this build shipped) renders as the raw id rather than crashing. */
export function agentName(agentNames: Record<KnownAgentId, string>, id: string): string {
  return agentNames[id as KnownAgentId] ?? id;
}

/** Two letters standing in for the agent in the trigger and the menu — "CC",
 * "CX". Not the vendor mark: the palette has no brand colours. */
function agentTile(agentId: string): string {
  if (agentId === "claude") return "CC";
  if (agentId === "codex") return "CX";
  return agentId.slice(0, 2).toUpperCase();
}

function AgentTile({ agentId, dim }: { agentId: string; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[calc(18px*var(--chrome-scale))] shrink-0 items-center justify-center border border-border bg-surface-hover font-mono text-[length:calc(9px*var(--chrome-scale))] font-semibold text-foreground",
        dim && "text-text-faint",
      )}
    >
      {agentTile(agentId)}
    </span>
  );
}

/** A section's right-hand note: where the row says what the choice does. */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto shrink-0 pl-4 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint">{children}</span>;
}

interface AgentModelEffortButtonProps {
  profile: Profile;
  /** This session's own agent, from `agent_state` — `null` in the brief
   * window before the first one arrives. Deliberately NOT derived from
   * `/host-info` (that's per-relay, not per-session). */
  agentId: string | null;
  onChangeAgent: (agentId: string) => void;
  model: ModelChoice | null;
  /** The session's agent's catalog, as that agent's own CLI lists it; `null`
   * until the relay's probe for this agent lands. */
  catalog: ModelCatalog | null;
  onChangeModel: (model: ModelChoice) => void;
  /** The explicit effort pick; `null` = none (the model's own default). */
  effort: string | null;
  /** `null` clears the pick. */
  onChangeEffort: (effort: string | null) => void;
  /** `true` before the first `model_state` arrives — nothing to switch yet. */
  disabled: boolean;
  /** `true` once the conversation has had its first turn: the agent and the
   * model are fixed from then on (switching would make the CLI re-read the
   * whole history under the new one). Effort is per turn and never locks. */
  locked: boolean;
}

/**
 * The composer's one control for agent, model and reasoning effort: a trigger
 * reading "[CC] Opus 4.6 default" that opens a menu with the three choices as
 * sections. They used to be three triggers in a row, which crowded a toolbar
 * that has a permission mode, attach, voice and send to fit as well.
 *
 * `modal={false}` as on every dropdown here — Radix traps focus/pointer-events
 * on the body while a modal one is open, and restoration fails on Tauri's
 * WKWebView on macOS. Every model and effort name comes from the session's
 * agent's own CLI (`catalog`); nothing here knows which agent that is.
 */
export function AgentModelEffortButton({
  profile,
  agentId,
  onChangeAgent,
  model,
  catalog,
  onChangeModel,
  effort,
  onChangeEffort,
  disabled,
  locked,
}: AgentModelEffortButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict().chat.composer;
  const [agents, setAgents] = useState<SelectableAgentInfo[]>([]);

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

  const currentModel = effectiveModel(catalog, model);
  const modelLabel = currentModel !== null ? labelForModel(catalog, currentModel) : dict.pending;
  const option = effectiveModelOption(catalog, model);
  const efforts = option?.efforts ?? [];
  const currentEffort = effectiveEffort(option, effort);
  const effortLabel = efforts.length === 0 ? null : currentEffort !== null ? labelForEffort(dict.effortLabels, currentEffort) : dict.effortDefault;
  const offersDefaultEffort = option?.defaultEffort === undefined;

  if (!catalog && agents.length <= 1) return null;

  const name = agentId !== null ? agentName(dict.agentNames, agentId) : "";
  const label = dict.agentMenuLabel.replace("{agent}", name).replace("{model}", modelLabel).replace("{effort}", effortLabel ?? dict.effortDefault);

  return (
    <DropdownMenu modal={false} onOpenChange={(open) => !open && triggerRef.current?.blur()}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          title={label}
          aria-label={effortLabel !== null ? label : `${name} · ${modelLabel}`}
          className={cn(toolbarTriggerClass, "gap-[7px] hover:bg-surface-hover data-[state=open]:bg-surface-hover")}
        >
          {agentId !== null && <AgentTile agentId={agentId} />}
          <span className="truncate text-foreground">{modelLabel}</span>
          {effortLabel !== null && <span className="shrink-0 text-text-faint">{effortLabel.toLowerCase()}</span>}
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[calc(300px*var(--chrome-scale))]">
        {agents.length > 1 && (
          <>
            <DropdownMenuLabel>{dict.menu.agent}</DropdownMenuLabel>
            {agents.map((agent) => {
              const current = agent.id === agentId;
              return (
                <DropdownMenuItem
                  key={agent.id}
                  disabled={locked && !current}
                  onSelect={() => !current && onChangeAgent(agent.id)}
                  className={cn("gap-2.5", current && "text-foreground")}
                >
                  <AgentTile agentId={agent.id} dim={!current} />
                  <span className="truncate">{agentName(dict.agentNames, agent.id)}</span>
                  <Hint>{current ? dict.menu.thisSession : dict.menu.newSession}</Hint>
                  <Check className={cn("size-3.5 text-foreground", !current && "opacity-0")} />
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}

        {catalog && (
          <>
            <DropdownMenuLabel>{dict.menu.model}</DropdownMenuLabel>
            {locked ? (
              <DropdownMenuItem disabled className="text-foreground opacity-100" title={dict.modelLocked}>
                <span className="truncate">{modelLabel}</span>
                <Hint>{dict.menu.fixedInSession}</Hint>
                <Lock className="size-3 shrink-0" />
              </DropdownMenuItem>
            ) : (
              catalog.options.map((entry) => (
                <DropdownMenuItem key={entry.id} onSelect={() => onChangeModel(entry.id)} title={entry.description} className={cn(entry.id === currentModel && "text-foreground")}>
                  <span className="flex-1 truncate text-left">{entry.label}</span>
                  <Check className={cn("size-3.5 shrink-0 text-foreground", entry.id !== currentModel && "opacity-0")} />
                </DropdownMenuItem>
              ))
            )}
          </>
        )}

        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{dict.menu.effort}</DropdownMenuLabel>
            {offersDefaultEffort && (
              <DropdownMenuItem onSelect={() => onChangeEffort(null)} className={cn(currentEffort === null && "text-foreground")}>
                <span className="flex-1 truncate text-left">{dict.effortDefault}</span>
                <Check className={cn("size-3.5 shrink-0 text-foreground", currentEffort !== null && "opacity-0")} />
              </DropdownMenuItem>
            )}
            {efforts.map((entry) => (
              <DropdownMenuItem key={entry.id} onSelect={() => onChangeEffort(entry.id)} title={entry.description} className={cn(entry.id === currentEffort && "text-foreground")}>
                <span className="flex-1 truncate text-left">{labelForEffort(dict.effortLabels, entry.id)}</span>
                <Check className={cn("size-3.5 shrink-0 text-foreground", entry.id !== currentEffort && "opacity-0")} />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
