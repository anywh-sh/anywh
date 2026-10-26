import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useOpen } from "@/lib/format/openState";
import { cn } from "@/lib/utils";

/** Height in px past which a message is clipped behind "Show all" — about
 * twenty lines of the bubble's text. */
const DEFAULT_CAP = 320;

/** A message only a few px over the cap isn't worth a toggle. */
const SLACK = 24;

const FADE = "linear-gradient(to bottom, currentColor calc(100% - 3rem), transparent)";

interface CollapsibleTextProps {
  /** Key in the chat's `OpenState`, so the choice survives the virtualized
   * log unmounting the row when it scrolls away. */
  id: string;
  expandLabel: string;
  collapseLabel: string;
  cap?: number;
  children: ReactNode;
}

/**
 * Clips a long block of content at `cap` with a fade and a toggle to read it
 * whole. Measured, not counted in lines: wrapping and rendered markdown are
 * what decide the height. Same shape as the activity `CodeBlock`'s cap.
 */
export function CollapsibleText({ id, expandLabel, collapseLabel, cap = DEFAULT_CAP, children }: CollapsibleTextProps) {
  const contentId = useId();
  const [open, toggle] = useOpen(id);
  const content = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);

  // Observed rather than read once: markdown, fonts and the bubble's width
  // all change the height after the first paint.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setNatural(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const capped = natural > cap + SLACK;
  const clipped = capped && !open;

  return (
    <>
      <div
        ref={content}
        id={contentId}
        className={cn("min-w-0", clipped && "overflow-y-hidden")}
        style={clipped ? { maxHeight: cap, maskImage: FADE, WebkitMaskImage: FADE } : undefined}
      >
        {children}
      </div>
      {capped && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          // The bubble arms its iOS long-press menu on `touchstart`; a tap on
          // the toggle is not a long-press on the message.
          onTouchStart={(event) => event.stopPropagation()}
          onClick={() => {
            toggle();
            // Folding a message whose top is above the viewport would leave
            // the reader somewhere below it; bring its start back into view.
            if (open) requestAnimationFrame(() => content.current?.scrollIntoView({ block: "nearest" }));
          }}
          className="cursor-pointer self-start font-mono text-[11px] text-text-faint transition-colors hover:text-foreground"
        >
          {open ? collapseLabel : expandLabel}
        </button>
      )}
    </>
  );
}
