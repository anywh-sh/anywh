import { useRef } from "react";
import { Check, ChevronDown, ShieldAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import type { Dictionary, KnownPermissionModeId } from "@/i18n/dictionary";
import type { PermissionMode, PermissionModeOption } from "@/lib/relay/relayClient";
import { cn } from "@/lib/utils";

interface PermissionModeButtonProps {
  mode: PermissionMode | null;
  /** Empty until the first `permission_mode_state` — the button is disabled
   * then anyway (`mode === null`). Ordering is the relay's (the session's
   * def's `modesFor` order), never re-sorted here: Claude's is the CLI's own
   * Shift+Tab cycle, Codex's is least-to-most permissive. */
  available: PermissionModeOption[];
  onChange: (mode: PermissionMode) => void;
}

/** Same id-switch-with-literal-fallback shape as `ChoiceCard.tsx`'s
 * `labelOf` (the precedent for turning an engine's own id into real text),
 * rather than resolving a `labelKey` shipped over the wire: a labelKey pipe
 * would be a second, competing mechanism for the same job, and the id is
 * just as stable a dictionary key. An id this build doesn't recognize (an
 * agent added after this build shipped) renders as the raw id with no
 * hint — visible, not fatal. Plain function, not a hook, so it can be
 * called conditionally/in a loop against a `dict` already resolved once by
 * the component. */
function modeCopy(composer: Dictionary["chat"]["composer"], id: PermissionMode): { label: string; hint: string } {
  return composer.mode[id as KnownPermissionModeId] ?? { label: id, hint: "" };
}

/**
 * Label + dropdown in the composer's toolbar, first control on the row.
 * Same `modal={false}` as every other dropdown in the app — Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS.
 *
 * The accent tint marks the one concept every agent's mode set shares: "this
 * mode never asks for approval" (`pausesForApproval: false` — Claude's
 * `bypassPermissions`, Codex's `full-access`), not a specific literal id.
 */
export function PermissionModeButton({ mode, available, onChange }: PermissionModeButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copy = useDict().chat.composer;
  const neverAsks = available.find((option) => option.id === mode)?.pausesForApproval === false;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="sm"
          disabled={mode === null}
          className={cn(
            "min-w-0 gap-1.5 px-2",
            neverAsks &&
              "border-primary bg-primary-soft text-primary-ink hover:border-primary hover:bg-primary-soft hover:text-primary-ink",
          )}
        >
          <ShieldAlert className="size-3" />
          <span className="truncate">{mode !== null ? modeCopy(copy, mode).label : copy.pending}</span>
          <ChevronDown className="size-2.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-59">
        {available.map((option) => {
          const { label, hint } = modeCopy(copy, option.id);
          return (
            <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)} className="items-start gap-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <span>{label}</span>
                <span className="font-sans text-[11px] text-muted-foreground">{hint}</span>
              </span>
              <Check className={cn("mt-px size-3.5 text-primary!", option.id !== mode && "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
