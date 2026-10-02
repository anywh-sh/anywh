import { useRef, useState } from "react";
import { Check, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarTriggerClass } from "@/components/chat/toolbarTrigger";
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
 * display name, version included — so
 * which model and which release is running is readable here instead of
 * only in the CLI. The CLI's blurb for each model is only a tooltip: shown
 * inline it made the menu too wide for the toolbar it opens from. Nothing
 * in this component knows which agent that is:
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
        <button
          ref={triggerRef}
          type="button"
          disabled={isDisabled}
          title={locked ? dict.chat.composer.modelLocked : undefined}
          // A locked model is still information worth reading, so it stays
          // at full opacity instead of fading out with the disabled controls.
          className={cn(toolbarTriggerClass, locked && "opacity-100")}
        >
          <span className="truncate">{label}</span>
          {locked ? (
            <Lock className="size-2.5 opacity-60" />
          ) : (
            <span aria-hidden="true" className="text-[9px] opacity-55">▾</span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-53">
        {catalog?.options.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)} className="gap-3" title={option.description}>
            <span className="flex-1 truncate text-left">{option.label}</span>
            <Check className={cn("size-3.5 shrink-0 text-primary!", option.id !== current && "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
