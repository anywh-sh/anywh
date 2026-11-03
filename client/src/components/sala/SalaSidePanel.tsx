import { useRef, type ReactNode } from "react";
import { useDict } from "@/i18n";
import { CloseIcon } from "@/components/sala/SalaIcons";
import { SalaPane } from "@/components/sala/SalaPane";
import { useSalaSideWidth } from "@/hooks/sala/useSalaSideWidth";

interface SalaSidePanelProps {
  /** The mark at the start of the header (an agent tile, the room glyph). */
  mark: ReactNode;
  title: string;
  /** `title` is only provisional: a placeholder is drawn in its place. */
  titlePending?: boolean;
  subtitle: string;
  /** What the panel is, for assistive tech and tests (`about`, `agent`, `principal`). */
  kind: string;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A room's pane on a layout with no dock (compact windows, iOS): docked in
 * the plane like the sidebar (it takes width from the canvas rather than
 * floating over it), with a close button in its header. Its left edge is a
 * handle that resizes it (`useSalaSideWidth`); a double click there restores
 * the default.
 */
export function SalaSidePanel({ onClose, ...pane }: SalaSidePanelProps) {
  const dict = useDict().sala.panel;
  const panel = useRef<HTMLDivElement>(null);
  const size = useSalaSideWidth(panel);
  return (
    <div ref={panel} className="sala-side">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={dict.resize}
        aria-valuenow={size.width}
        aria-valuemin={size.min}
        aria-valuemax={size.max}
        tabIndex={0}
        className="sala-side-grip"
        data-dragging={size.dragging ? "" : undefined}
        {...size.gripProps}
      />
      <SalaPane
        {...pane}
        onClose={onClose}
        headerActions={
          <button type="button" className="sala-side-close" onClick={onClose} aria-label={dict.close} title={dict.close}>
            <CloseIcon size={12} />
          </button>
        }
      />
    </div>
  );
}
