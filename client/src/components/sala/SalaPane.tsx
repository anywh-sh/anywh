import type { ReactNode } from "react";
import { TitleSkeleton } from "@/components/ui/title-skeleton";

interface SalaPaneProps {
  /** The mark at the start of the header (an agent tile, the room glyph). */
  mark: ReactNode;
  title: string;
  /** `title` is only provisional: a placeholder is drawn in its place. */
  titlePending?: boolean;
  subtitle: string;
  /** What the pane is, for assistive tech and tests (`about`, `agent`, `principal`). */
  kind: string;
  /** The controls at the header's end: a close button, or the dock's maximize and close. */
  headerActions: ReactNode;
  footer?: ReactNode;
  /** Esc pressed inside the pane. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * What a room shows about itself or one of its agents: a header with what it
 * is about, a scrolling body and an optional footer. Esc closes it from
 * anywhere inside. It fills whatever holds it and knows nothing of that:
 * the dock gives it a pane of the column, the compact layout (`SalaSidePanel`)
 * a panel of its own.
 */
export function SalaPane({ mark, title, titlePending, subtitle, kind, headerActions, footer, onClose, children }: SalaPaneProps) {
  return (
    <aside
      className="sala-pane"
      data-panel={kind}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="sala-side-head">
        <span className="sala-side-mark">{mark}</span>
        <div className="sala-side-titles">
          <h2 className="sala-side-title">{titlePending === true ? <TitleSkeleton className="h-4 w-44" /> : title}</h2>
          <p className="sala-side-sub">{subtitle}</p>
        </div>
        {headerActions}
      </header>
      {children}
      {footer && <footer className="sala-side-foot">{footer}</footer>}
    </aside>
  );
}
