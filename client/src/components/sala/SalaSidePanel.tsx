import type { ReactNode } from "react";
import { TitleSkeleton } from "@/components/ui/title-skeleton";
import { useDict } from "@/i18n";
import { CloseIcon } from "@/components/sala/SalaIcons";

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
 * The room's right-hand panel: docked in the plane like the sidebar (it
 * takes width from the canvas rather than floating over it), a header with
 * what it is about and a close button, a scrolling body and an optional
 * footer. Esc closes it from anywhere inside.
 */
export function SalaSidePanel({ mark, title, titlePending, subtitle, kind, footer, onClose, children }: SalaSidePanelProps) {
  const dict = useDict().sala.panel;
  return (
    <aside
      className="sala-side"
      data-panel={kind}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="sala-side-in">
        <header className="sala-side-head">
          <span className="sala-side-mark">{mark}</span>
          <div className="sala-side-titles">
            <h2 className="sala-side-title">{titlePending === true ? <TitleSkeleton className="h-4 w-44" /> : title}</h2>
            <p className="sala-side-sub">{subtitle}</p>
          </div>
          <button type="button" className="sala-side-close" onClick={onClose} aria-label={dict.close} title={dict.close}>
            <CloseIcon size={12} />
          </button>
        </header>
        {children}
        {footer && <footer className="sala-side-foot">{footer}</footer>}
      </div>
    </aside>
  );
}
