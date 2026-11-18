import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { AgentLogo } from "@/components/chat/AgentLogo";
import { useDict } from "@/i18n";
import type { KnownAgentId } from "@/i18n/dictionary";
import { getHostInfo } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";
import type { ModelCatalog, ModelChoice, ModelOption } from "@/lib/relay/relay-types";
import { effectiveModel, labelForModel, splitModelOptions } from "@/lib/composer/modelCatalog";
import { effectiveEffort, effectiveModelOption, labelForEffort } from "@/lib/composer/effortCatalog";
import { cn } from "@/lib/utils";

/** Same id-switch-with-literal-fallback shape as `PermissionModeButton`'s
 * `modeCopy` — an agent id this build has no name for (a def added after
 * this build shipped) renders as the raw id rather than crashing. */
export function agentName(agentNames: Record<KnownAgentId, string>, id: string): string {
  return agentNames[id as KnownAgentId] ?? id;
}

/** The runtime's own mark, bare: no tile behind it, no border. */
function AgentTile({ agentId, dim }: { agentId: string; dim?: boolean }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center text-foreground", dim && "text-text-faint")}>
      <AgentLogo agentId={agentId} className="size-[calc(14px*var(--chrome-scale))]" />
    </span>
  );
}

/** A submenu row: label, then its hint against the primitive's chevron. The
 * label takes the slack (`flex-1`) so the chevron always ends the row, with
 * or without a hint; the chevron's own auto margin then has nothing left. */
const SUB_ROW = "[&>svg:last-child]:ml-1.5";

function SubRowLabel({ children }: { children: React.ReactNode }) {
  return <span className="min-w-0 flex-1 truncate">{children}</span>;
}

/** A submenu row's hint: sits right before the chevron. */
function SubHint({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 pl-4 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint">{children}</span>;
}

/** A section's right-hand note: where the row says what the choice does. */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto shrink-0 pl-4 font-mono text-[length:calc(11px*var(--chrome-scale))] text-text-faint">{children}</span>;
}

/** The check on a row's right end, held in place (invisible) on the others
 * so labels don't shift as the pick moves. */
function RowCheck({ current }: { current: boolean }) {
  return <Check className={cn("ml-auto size-3.5 shrink-0 text-foreground", !current && "invisible")} />;
}

function ModelRow({ entry, current, onSelect }: { entry: ModelOption; current: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} title={entry.description} className={cn(current && "text-foreground")}>
      <span className="truncate">{entry.label}</span>
      <RowCheck current={current} />
    </DropdownMenuItem>
  );
}

interface AgentModelEffortMenuProps {
  /** The agents this relay can run, in its own order. The agent row only
   * shows with more than one. */
  agents: readonly string[];
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
  /** Opens the menu on mount — for stories and screenshots only. */
  defaultOpen?: boolean;
  /** Which submenu `defaultOpen` also opens — stories only. */
  defaultSubmenu?: Submenu;
}

type Submenu = "effort" | "more" | "agent";

/**
 * The composer's one control for agent, model and reasoning effort: a trigger
 * reading "[logo] Opus 5.5 high" that opens a short menu shaped like the
 * agents' own pickers —
 *
 *   Model · this session
 *     the CLI's current line-up, one model per purpose
 *   Effort ›        the levels, with what they cost
 *   More models ›   the models a newer one replaces (`superseded`)
 *   Agent ›         the other runtimes this relay has
 *
 * The frequent choice (model) is one click; the rest are one hover away, so
 * a catalog of thirteen models or a relay with three agents doesn't turn the
 * menu into a wall. Rows that have nothing to offer don't render: no "More
 * models" while nothing in the catalog is superseded, no Effort for a model
 * that takes none, no Agent row on a relay with one.
 *
 * `modal={false}` as on every dropdown here — Radix traps focus/pointer-events
 * on the body while a modal one is open, and restoration fails on Tauri's
 * WKWebView on macOS. Every model and effort name comes from the session's
 * agent's own CLI (`catalog`); nothing here knows which agent that is.
 */
export function AgentModelEffortMenu({
  agents,
  agentId,
  onChangeAgent,
  model,
  catalog,
  onChangeModel,
  effort,
  onChangeEffort,
  disabled,
  locked,
  defaultOpen = false,
  defaultSubmenu,
}: AgentModelEffortMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const dict = useDict().chat.composer;
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  // A story's pre-opened submenu opens a tick after the root menu: the root
  // focuses itself on open, and a submenu already open then reads that as
  // focus leaving it and closes.
  useEffect(() => {
    if (!defaultOpen || !defaultSubmenu) return;
    const timer = setTimeout(() => setSubmenu(defaultSubmenu));
    return () => clearTimeout(timer);
  }, [defaultOpen, defaultSubmenu]);
  const subProps = (key: Submenu) => ({
    open: submenu === key,
    onOpenChange: (next: boolean) => setSubmenu((current) => (next ? key : current === key ? null : current)),
  });

  const currentModel = effectiveModel(catalog, model);
  const modelLabel = currentModel !== null ? labelForModel(catalog, currentModel) : dict.pending;
  const { primary, more } = splitModelOptions(catalog);
  const currentInMore = more.find((entry) => entry.id === currentModel);
  const option = effectiveModelOption(catalog, model);
  const efforts = option?.efforts ?? [];
  const currentEffort = effectiveEffort(option, effort);
  const effortLabel = efforts.length === 0 ? null : currentEffort !== null ? labelForEffort(dict.effortLabels, currentEffort) : dict.effortDefault;
  const offersDefaultEffort = option?.defaultEffort === undefined;

  if (!catalog && agents.length <= 1) return null;

  const name = agentId !== null ? agentName(dict.agentNames, agentId) : "";
  const label = dict.agentMenuLabel.replace("{agent}", name).replace("{model}", modelLabel).replace("{effort}", effortLabel ?? dict.effortDefault);
  const pickModel = (id: ModelChoice) => id !== currentModel && onChangeModel(id);

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          ref={triggerRef}
          variant="chrome"
          size="toolbar"
          disabled={disabled}
          title={label}
          aria-label={effortLabel !== null ? label : `${name} · ${modelLabel}`}
          // Disabled still takes the pointer, so the title still names the model.
          className="gap-[7px] disabled:pointer-events-auto disabled:cursor-default"
        >
          {agentId !== null && <AgentTile agentId={agentId} />}
          <span className="truncate text-foreground">{modelLabel}</span>
          {effortLabel !== null && <span className="shrink-0 text-text-faint">{effortLabel.toLowerCase()}</span>}
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="min-w-[calc(220px*var(--chrome-scale))]">
        {catalog && (
          <>
            <DropdownMenuLabel>{dict.menu.modelHeader}</DropdownMenuLabel>
            {locked ? (
              <DropdownMenuItem disabled className="text-foreground opacity-100" title={dict.modelLocked}>
                <span className="truncate">{modelLabel}</span>
                <Hint>{dict.menu.fixedInSession}</Hint>
                <Lock className="size-3 shrink-0" />
              </DropdownMenuItem>
            ) : (
              primary.map((entry) => <ModelRow key={entry.id} entry={entry} current={entry.id === currentModel} onSelect={() => pickModel(entry.id)} />)
            )}
          </>
        )}

        {(efforts.length > 0 || (!locked && more.length > 0)) && <DropdownMenuSeparator />}

        {efforts.length > 0 && (
          <DropdownMenuSub {...subProps("effort")}>
            <DropdownMenuSubTrigger className={SUB_ROW}>
              <SubRowLabel>{dict.menu.effort}</SubRowLabel>
              <SubHint>{effortLabel}</SubHint>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent sideOffset={6} className="w-[calc(260px*var(--chrome-scale))]">
                <p className="px-3 pt-1 pb-2 text-[length:calc(12px*var(--chrome-scale))] leading-snug text-text-faint">{dict.menu.effortHint}</p>
                {offersDefaultEffort && (
                  <DropdownMenuItem onSelect={() => onChangeEffort(null)} className={cn(currentEffort === null && "text-foreground")}>
                    <span className="truncate">{dict.effortDefault}</span>
                    <RowCheck current={currentEffort === null} />
                  </DropdownMenuItem>
                )}
                {efforts.map((entry) => (
                  <DropdownMenuItem key={entry.id} onSelect={() => onChangeEffort(entry.id)} title={entry.description} className={cn(entry.id === currentEffort && "text-foreground")}>
                    <span className="truncate">{labelForEffort(dict.effortLabels, entry.id)}</span>
                    {entry.id === option?.defaultEffort && <Badge>{dict.effortDefault}</Badge>}
                    <RowCheck current={entry.id === currentEffort} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        )}

        {!locked && more.length > 0 && (
          <DropdownMenuSub {...subProps("more")}>
            <DropdownMenuSubTrigger className={cn(SUB_ROW, currentInMore && "text-foreground")}>
              <SubRowLabel>{dict.menu.moreModels}</SubRowLabel>
              {currentInMore && <SubHint>{currentInMore.label}</SubHint>}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent sideOffset={6} className="scrollbar-thin max-h-(--radix-dropdown-menu-content-available-height) min-w-[calc(180px*var(--chrome-scale))] overflow-y-auto">
                {more.map((entry) => (
                  <ModelRow key={entry.id} entry={entry} current={entry.id === currentModel} onSelect={() => pickModel(entry.id)} />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        )}

        {agents.length > 1 && (
          <>
            {(catalog || efforts.length > 0) && <DropdownMenuSeparator />}
            {locked ? (
              <DropdownMenuItem disabled className="opacity-100" title={dict.modelLocked}>
                <span>{dict.menu.agent}</span>
                <Hint>{name}</Hint>
                <Lock className="size-3 shrink-0" />
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub {...subProps("agent")}>
                <DropdownMenuSubTrigger className={SUB_ROW}>
                  <SubRowLabel>{dict.menu.agent}</SubRowLabel>
                  <span className="flex shrink-0 items-center gap-1.5 pl-4 text-text-faint">
                    {agentId !== null && <AgentTile agentId={agentId} dim />}
                    <span className="font-mono text-[length:calc(11px*var(--chrome-scale))]">{name}</span>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent sideOffset={6} className="min-w-[calc(220px*var(--chrome-scale))]">
                    {agents.map((id) => {
                      const current = id === agentId;
                      return (
                        <DropdownMenuItem key={id} onSelect={() => !current && onChangeAgent(id)} className={cn("gap-2.5", current && "text-foreground")}>
                          <AgentTile agentId={id} dim={!current} />
                          <span className="truncate">{agentName(dict.agentNames, id)}</span>
                          {current ? <Check className="ml-auto size-3.5 shrink-0 text-foreground" /> : <Hint>{dict.menu.newSession}</Hint>}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu wired to the relay: reads which agents it can run from
 * `/host-info`, everything else from the session. */
export function AgentModelEffortButton({ profile, ...props }: Omit<AgentModelEffortMenuProps, "agents" | "defaultOpen" | "defaultSubmenu"> & { profile: Profile }) {
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getHostInfo(profile)
      .then((info) => {
        if (!cancelled) setAgents((info.agents ?? []).map((agent) => agent.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile]);

  return <AgentModelEffortMenu agents={agents} {...props} />;
}
