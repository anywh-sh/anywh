import { useDict } from "@/i18n";
import { isMacOS } from "@/lib/platform/platform";
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
      <span className="sala-mbar-h">{dict.hint.replace("{keys}", isMacOS() ? dict.keysMac : dict.keysOther)}</span>
      <button type="button" onClick={onGroup}>
        <AreaIcon size={13} />
        <span>{dict.group}</span>
      </button>
      {canStop && (
        <button type="button" onClick={onStop}>
          <span aria-hidden="true" style={{ width: 8, height: 8, background: "currentColor" }} />
          <span>{dict.stop}</span>
        </button>
      )}
      <button type="button" className="danger" onClick={onRemove}>
        <TrashIcon size={13} />
        <span>{dict.remove}</span>
      </button>
      <span className="sala-sep" aria-hidden="true" />
      <button type="button" className="sala-mbar-x" onClick={onClear} aria-label={dict.clear} title={dict.clear}>
        <CloseIcon size={11} />
      </button>
    </div>
  );
}
