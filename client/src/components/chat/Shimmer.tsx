import { cn } from "@/lib/utils";

interface ShimmerProps {
  /** The text. A plain string: it is drawn twice, and the copy is aria-hidden. */
  children: string;
  className?: string;
  /** Turns the sweep off without unmounting, e.g. once the work is done. */
  active?: boolean;
}

// The mask reads only alpha, so any opaque colour will do: `currentColor` keeps a
// literal out of the component (designVocabulary.test.ts). Set under both
// names because WebKit before 15.4 (older macOS webviews) only knows the
// prefixed property, and with no mask the window would show as a hard-edged
// bright copy of the label sliding across it.
const EDGE_MASK = "linear-gradient(90deg, transparent 30%, currentColor 50%, transparent 70%)";

/**
 * A light band sweeping across a label while something is working.
 *
 * Two layers rather than a gradient clipped to the text: the base label stays
 * put, and a copy in the foreground colour sits on top inside a window with a
 * soft, *static* edge mask. Only the window and its content move, both by
 * `transform` (the content counter-moves so the text itself never shifts), so
 * it runs on the compositor and repaints nothing. Animating
 * `background-position` over `background-clip: text` is the version the
 * motion budget in `index.css` rules out.
 */
export function Shimmer({ children, className, active = true }: ShimmerProps) {
  return (
    <span className={cn("relative inline-block whitespace-nowrap", className)}>
      {children}
      {active && (
        <span
          aria-hidden
          className="animate-shimmer-window pointer-events-none absolute inset-0 overflow-hidden"
          style={{ maskImage: EDGE_MASK, WebkitMaskImage: EDGE_MASK }}
        >
          <span className="animate-shimmer-text block text-foreground">{children}</span>
        </span>
      )}
    </span>
  );
}
