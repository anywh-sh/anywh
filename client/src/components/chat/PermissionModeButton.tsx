import { useRef } from "react";
import { Asterisk, Check, ChevronDown, ClipboardList, SquareCheck, Zap, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarTriggerClass } from "@/components/chat/toolbarTrigger";
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

/** The mark leading each mode, by what the mode does with approvals rather
 * than by an agent's id: one that never asks gets the asterisk, an
 * edits-without-asking one the bolt, a plan-only one the list; the rest — the
 * ones that ask — the checked box. */
function modeIcon(option: PermissionModeOption | undefined): LucideIcon {
  if (option === undefined) return SquareCheck;
  if (option.pausesForApproval === false) return Asterisk;
  if (/plan|read-only/i.test(option.id)) return ClipboardList;
  if (/accept|auto/i.test(option.id)) return Zap;
  return SquareCheck;
}

function ModeMark({ option }: { option: PermissionModeOption | undefined }) {
  const Icon = modeIcon(option);
  return <Icon className={cn("size-[calc(14px*var(--chrome-scale))] shrink-0", option?.pausesForApproval === false && "text-context-ring-warn")} aria-hidden />;
}

/**
 * Label + dropdown in the composer's toolbar, first control on the row.
 * Same `modal={false}` as every other dropdown in the app — Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS.
 *
 * The warning tint (on the icon only, the label stays plain) marks the one concept every agent's mode set shares: "this
 * mode never asks for approval" (`pausesForApproval: false` — Claude's
 * `bypassPermissions`, Codex's `full-access`), not a specific literal id.
 */
export function PermissionModeButton({ mode, available, onChange }: PermissionModeButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copy = useDict().chat.composer;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={mode === null}
          className={cn(toolbarTriggerClass, "gap-[7px] hover:bg-surface-hover data-[state=open]:bg-surface-hover")}
        >
          {mode !== null && <ModeMark option={available.find((option) => option.id === mode)} />}
          <span className="truncate">{mode !== null ? modeCopy(copy, mode).label : copy.pending}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-59">
        {available.map((option) => {
          const { label, hint } = modeCopy(copy, option.id);
          return (
            <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)} className={cn("h-auto items-start gap-2.5 py-1.5", option.id === mode && "text-foreground")}>
              <span className="mt-0.5">
                <ModeMark option={option} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <span>{label}</span>
                <span className="font-sans text-[11px] text-text-faint">{hint}</span>
              </span>
              <Check className={cn("mt-px size-3.5 text-foreground", option.id !== mode && "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
