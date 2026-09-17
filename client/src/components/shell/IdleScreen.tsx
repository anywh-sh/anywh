import { useKeyboardInset } from "@/hooks/platform/useKeyboardInset";

interface IdleScreenProps {
  heading: string;
  subtitle: string;
}

/** Base visual for the idle state (blinking cursor + heading + supporting
 * text), reused both for "no tab open" (EmptyState) and "new tab, no
 * messages yet" (ChatIdleState). */
export function IdleScreen({ heading, subtitle }: IdleScreenProps) {
  // Counters the same WebKit visual-viewport pan `MobileTopBar` compensates
  // for — this content is normal document flow, not
  // `position: fixed`, so it isn't anchored to the layout viewport the way
  // the header is, but it's still meant to read as a still background behind
  // the composer, not something that scrolls. Without this, opening the
  // keyboard on `ChatIdleState` (the only caller with a visible composer —
  // `EmptyState` has no input on screen, so no keyboard can open there)
  // visually slides the centered heading up along with the pan. A no-op
  // (`offsetTop` stays 0) everywhere else, including desktop/`EmptyState`.
  const { offsetTop } = useKeyboardInset();

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      style={offsetTop ? { transform: `translateY(${offsetTop}px)` } : undefined}
    >
      <span className="animate-cursor-blink font-mono text-3xl text-text-faint">▍</span>
      <h2 className="text-lg font-medium text-foreground">{heading}</h2>
      <p className="max-w-xs text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}
