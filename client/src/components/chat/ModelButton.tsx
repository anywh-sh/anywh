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
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relayClient";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import { cn } from "@/lib/utils";

interface ModelButtonProps {
  model: ModelChoice | null;
  /** The session's agent's catalog, as that agent's own CLI lists it —
   * every label here is the CLI's own display name ("Opus 5.5",
   * "GPT-5.5"), and `defaultId` is what `model === null` actually runs.
   * `null` until the relay's probe for this agent lands. */
  catalog: ModelCatalog | null;
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
 * Every name comes from the session's agent's own CLI (`catalog`) and is
 * shown the way that CLI's own picker shows it — one entry per model, its
 * display name, version included, and its own blurb muted beside it — so
 * which model and which release is running is readable here instead of
 * only in the CLI. Nothing in this component knows which agent that is:
 * a new agent gets a picker by its runtime def declaring a catalog.
 */
export function ModelButton({ model, catalog, onChange, disabled, locked }: ModelButtonProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dict = useDict();
  const current = effectiveModel(catalog, model);
  const label = current !== null ? labelForModel(catalog, current) : dict.chat.composer.pending;
  const isDisabled = disabled || locked || current === null;
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

      <DropdownMenuContent align="start" className="max-w-96 min-w-53">
        {catalog?.options.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)} className="gap-3">
            {/* A fixed-width name column so the blurbs line up the way the
                CLI's own picker lays them out. */}
            <span className="min-w-28 shrink-0 text-left">{option.label}</span>
            <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground" title={option.description}>
              {option.description}
            </span>
            <Check className={cn("size-3.5 shrink-0 text-primary!", option.id !== current && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
