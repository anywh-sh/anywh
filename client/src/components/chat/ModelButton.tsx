import { useRef, useState } from "react";
import { Check, ChevronDown, Lock, Target } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import type { ModelChoice } from "@/lib/relay/relayClient";
import { getKnownModels, labelForModel } from "@/lib/composer/modelCatalog";
import { cn } from "@/lib/utils";

interface ModelButtonProps {
  model: ModelChoice | null;
  /** This profile's account's actual default model, used as the
   * label when `model` is `null` (no explicit switch yet) — the defaults
   * are DIFFERENT between profiles (personal came up Sonnet, work came up
   * Opus), so we can't just hardcode a name here without really probing it. */
  defaultModel: string | null;
  onChange: (model: ModelChoice) => void;
  /** `true` before the first `permission_mode_state`/`model_state` arrives —
   * nothing to show yet, and nothing to switch to. */
  disabled: boolean;
  /** `true` once the conversation has had its first turn: switching the
   * model then would require rereading the whole history for the CLI to
   * rebuild context under the new model, so the switch is only valid before
   * that (same reasoning as `cwdLocked` / `WorkingDirectoryButton`). Kept
   * separate from `disabled` because this is the state the button explains
   * — it grows a padlock and a tooltip saying why, instead of just going
   * grey for no visible reason. */
  locked: boolean;
}

/**
 * Label + dropdown next to `PermissionModeButton`, second control on the
 * composer's toolbar. Same `modal={false}` as the rest — Radix traps
 * focus/pointer-events on the body while a modal dropdown is open, and
 * restoration fails on Tauri's WKWebView on macOS. Before this the model was
 * just text (`ModelLabel`); it became a dropdown so it doesn't depend on
 * typing `/model` in the composer.
 *
 * The items are one line each, with no blurb under them — unlike the
 * permission modes next door. The catalog is whatever the CLI reports at
 * runtime (`getKnownModels`), so a curated blurb per alias would go stale
 * the day the CLI ships a new one, and the fallback would read worse than
 * no blurb at all.
 */
export function ModelButton({ model, defaultModel, onChange, disabled, locked }: ModelButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict();
  const label = model ? labelForModel(model, dict.chat.composer.modelAliases) : (defaultModel ?? dict.chat.composer.pending);
  const isDisabled = disabled || locked || label === dict.chat.composer.pending;
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu
      modal={false}
      // Controlled (not just `onOpenChange`) on purpose: passing `disabled`
      // only to the child `<button>` via `asChild` wasn't enough — Radix's
      // `Trigger` reads its OWN `disabled` prop (default `false`, since we
      // only gave it `asChild`) to decide whether to ignore
      // pointerdown/keydown, so the menu would open even with the button
      // greyed out/locked on at least one WebView (same class of quirk that
      // motivated `modal={false}` above). Blocking the opening here, in
      // state, works no matter which low-level event the WebView decided to
      // fire on a `<button disabled>`.
      open={open}
      onOpenChange={(next) => {
        if (next && isDisabled) return;
        setOpen(next);
        if (!next) triggerRef.current?.blur();
      }}
    >
      <DropdownMenuTrigger asChild disabled={isDisabled}>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="sm"
          disabled={isDisabled}
          title={locked ? dict.chat.composer.modelLocked : undefined}
          // A locked model is still information worth reading, so it keeps a
          // surface instead of fading out with the rest of the disabled
          // controls.
          className={cn("min-w-0 gap-1.5 px-2", locked && "bg-bg-sidebar text-muted-foreground opacity-100")}
        >
          <Target className="size-3" />
          <span className="truncate">{label}</span>
          {locked ? <Lock className="size-2.5 opacity-60" /> : <ChevronDown className="size-2.5 opacity-60" />}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-53">
        {getKnownModels().map((choice) => (
          <DropdownMenuItem key={choice} onSelect={() => onChange(choice)} className="gap-3">
            <span className="flex-1 truncate text-left">{labelForModel(choice, dict.chat.composer.modelAliases)}</span>
            <Check className={cn("size-3.5 text-primary!", choice !== model && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
