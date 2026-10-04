import { useRef } from "react";
import { Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toolbarTriggerClass } from "@/components/chat/toolbarTrigger";
import { useDict } from "@/i18n";
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relayClient";
import { effectiveEffort, effectiveModelOption, labelForEffort } from "@/lib/composer/effortCatalog";
import { cn } from "@/lib/utils";

interface EffortButtonProps {
  /** The explicit effort pick; `null` = none (the model's own default). */
  effort: string | null;
  model: ModelChoice | null;
  catalog: ModelCatalog | null;
  /** `null` clears the pick. */
  onChange: (effort: string | null) => void;
  disabled: boolean;
}

/**
 * Reasoning-effort dropdown, right after `ModelButton`. Unlike the model it
 * is never locked: the CLI takes effort per turn, so it can change anywhere
 * in the conversation. Hidden when the effective model lists no efforts
 * (the CLI doesn't support it for that model, or at all).
 *
 * With no explicit pick the trigger shows the model's own default effort when
 * the CLI reports one (Codex). When it doesn't (Claude) the trigger reads
 * "Default" and the menu gets a matching entry that clears the pick — a
 * model that reports a default never needs that entry, since picking the
 * default level is the same thing. Level ids are opaque; labels come from the
 * dictionary, falling back to the raw id.
 */
export function EffortButton({ effort, model, catalog, onChange, disabled }: EffortButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict().chat.composer;
  const option = effectiveModelOption(catalog, model);
  const efforts = option?.efforts ?? [];
  if (efforts.length === 0) return null;

  const current = effectiveEffort(option, effort);
  const label = current !== null ? labelForEffort(dict.effortLabels, current) : dict.effortDefault;
  const offersDefault = option?.defaultEffort === undefined;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button ref={triggerRef} type="button" disabled={disabled} aria-label={dict.effortAriaLabel} className={toolbarTriggerClass}>
          <span className="truncate">{label}</span>
          <span aria-hidden="true" className="text-[9px] opacity-55">▾</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-40">
        {offersDefault && (
          <DropdownMenuItem onSelect={() => onChange(null)} className="gap-3">
            <span className="flex-1 truncate text-left">{dict.effortDefault}</span>
            <Check className={cn("size-3.5 shrink-0 text-primary!", current !== null && "opacity-0")} />
          </DropdownMenuItem>
        )}
        {efforts.map((entry) => (
          <DropdownMenuItem key={entry.id} onSelect={() => onChange(entry.id)} className="gap-3" title={entry.description}>
            <span className="flex-1 truncate text-left">{labelForEffort(dict.effortLabels, entry.id)}</span>
            <Check className={cn("size-3.5 shrink-0 text-primary!", entry.id !== current && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
