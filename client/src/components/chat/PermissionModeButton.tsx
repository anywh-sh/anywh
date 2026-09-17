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
import type { PermissionMode } from "@/lib/relay/relayClient";
import { cn } from "@/lib/utils";

interface PermissionModeButtonProps {
  mode: PermissionMode | null;
  onChange: (mode: PermissionMode) => void;
}

// 4 of the 6 values `claude --permission-mode` accepts — `auto` and
// `dontAsk` were left out on purpose. Order aligned with the
// CLI's Shift+Tab cycle (default -> acceptEdits -> plan), bypass last since
// it's the riskiest. Only the order lives here now; the label and the
// one-line hint under it come from the dictionary.
const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/**
 * Label + dropdown in the composer's toolbar, first control on the row.
 * Same `modal={false}` as every other dropdown in the app — Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS.
 *
 * Bypass is the one mode that paints itself: it's the only choice that lets
 * a destructive command through unasked, so it carries the accent tint
 * instead of reading like the other three.
 */
export function PermissionModeButton({ mode, onChange }: PermissionModeButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict();
  const copy = dict.chat.composer;

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
            mode === "bypassPermissions" &&
              "border-primary bg-primary-soft text-primary-ink hover:border-primary hover:bg-primary-soft hover:text-primary-ink",
          )}
        >
          <ShieldAlert className="size-3" />
          <span className="truncate">{mode ? copy.mode[mode].label : copy.pending}</span>
          <ChevronDown className="size-2.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-59">
        {MODES.map((value) => (
          <DropdownMenuItem key={value} onSelect={() => onChange(value)} className="items-start gap-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span>{copy.mode[value].label}</span>
              <span className="font-sans text-[11px] text-muted-foreground">{copy.mode[value].hint}</span>
            </span>
            <Check className={cn("mt-px size-3.5 text-primary!", value !== mode && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
