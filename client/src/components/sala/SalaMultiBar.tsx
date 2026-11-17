import { Button } from "@/components/ui/button";
import { useDict } from "@/i18n";
import { modifierKeyLabel, shiftKeyLabel } from "@/lib/platform/platform";
import { AreaIcon, CloseIcon, TrashIcon } from "@/components/sala/SalaIcons";

interface SalaMultiBarProps {
  count: number;
  /** Some of the selected agents can be stopped. */
  canStop: boolean;
  onGroup: () => void;
  onStop: () => void;
  onRemove: () => void;
  onClear: () => void;
}

/** The bar over the room while several agents are selected: how many, how
 * to change the selection, and what can be done to all of them at once. */
export function SalaMultiBar({ count, canStop, onGroup, onStop, onRemove, onClear }: SalaMultiBarProps) {
  const dict = useDict().sala.multi;
  return (
    <div className="sala-float sala-mbar" data-float role="toolbar" aria-label={dict.label}>
      <span className="sala-mbar-n">{dict.count.replace("{count}", String(count))}</span>
      <span className="sala-mbar-h">{dict.hint.replace("{shift}", shiftKeyLabel()).replace("{mod}", modifierKeyLabel())}</span>
      <Button variant="chrome" size="bar" onClick={onGroup}>
        <AreaIcon size={13} />
        <span>{dict.group}</span>
      </Button>
      {canStop && (
        <Button variant="chrome" size="bar" onClick={onStop}>
          <span aria-hidden="true" style={{ width: 8, height: 8, background: "currentColor" }} />
          <span>{dict.stop}</span>
        </Button>
      )}
      <Button variant="chrome" size="bar" className="hover:text-destructive" onClick={onRemove}>
        <TrashIcon size={13} />
        <span>{dict.remove}</span>
      </Button>
      <span className="sala-sep" aria-hidden="true" />
      <Button variant="chrome" size="icon" className="size-[26px]" onClick={onClear} aria-label={dict.clear} title={dict.clear}>
        <CloseIcon size={11} />
      </Button>
    </div>
  );
}
